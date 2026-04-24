"use client";

import { useEffect, useState, useRef } from "react";
import { useAppStore } from "@/lib/store";
import { auth, db } from "@/lib/firebase";
import { collection, query, where, getDocs, doc, onSnapshot, setDoc, serverTimestamp, orderBy, limit, addDoc, updateDoc } from "firebase/firestore";
import { io, Socket } from "socket.io-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PhoneCall, Video, Search, Send, User as UserIcon } from "lucide-react";
import { CallOverlay } from "./CallOverlay";

export function Main() {
  const { myPhone, activePeer, setActivePeer, setIsCalling } = useAppStore();
  const [peerInput, setPeerInput] = useState("");
  const [peerUid, setPeerUid] = useState<string | null>(null);
  const [peerStatus, setPeerStatus] = useState<"online" | "offline" | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [messageText, setMessageText] = useState("");
  const [isPeerTyping, setIsPeerTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Global presence & incoming calls listener
  useEffect(() => {
    if (!auth.currentUser) return;
    const uid = auth.currentUser.uid;
    
    // Heartbeat for presence
    const interval = setInterval(() => {
      updateDoc(doc(db, "users", uid), {
        lastSeen: serverTimestamp()
      }).catch(console.error);
    }, 60000); // Every minute

    // Incoming call listener
    const callsQuery = query(collection(db, "calls"), where("receiverId", "==", uid), where("status", "==", "ringing"));
    const unsubCalls = onSnapshot(callsQuery, (snap) => {
      snap.docChanges().forEach(change => {
        if (change.type === "added") {
          useAppStore.getState().setIncomingCall({ id: change.doc.id, ...change.doc.data() });
        }
      });
    });

    return () => {
      clearInterval(interval);
      unsubCalls();
      // Optional: Set offline on dismount using a beacon or similar in real app
    };
  }, []);

  // Find peer logic
  const handleFindPeer = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!peerInput || peerInput === myPhone) return;

    try {
      const q = query(collection(db, "users"), where("phoneNumber", "==", peerInput));
      const snap = await getDocs(q);
      
      let foundUid = null;
      let latestSeen = 0;
      
      snap.forEach(d => {
        const data = d.data();
        const seenAt = data.lastSeen?.toMillis() || 0;
        if (seenAt > latestSeen) {
          latestSeen = seenAt;
          foundUid = d.id;
        }
      });

      if (foundUid) {
        setPeerUid(foundUid);
        setActivePeer(peerInput);
        
        // Setup Chat ID
        const myUid = auth.currentUser!.uid;
        const newChatId = [myUid, foundUid].sort().join("_");
        setChatId(newChatId);
        
        // Ensure chat document exists
        await setDoc(doc(db, "chats", newChatId), {
          participants: [myUid, foundUid].sort(),
          lastMessageAt: serverTimestamp()
        }, { merge: true });

        // Update my own focused chat
        await updateDoc(doc(db, "users", myUid), { focusedChat: foundUid }).catch(console.error);

        // Listen to peer presence & focus
        const unsubPeer = onSnapshot(doc(db, "users", foundUid), (d) => {
          if (d.exists()) {
             const data = d.data();
             const isOnline = data.status === "online";
             const isFocusedOnMe = data.focusedChat === myUid;
             if (isOnline && isFocusedOnMe) {
               setPeerStatus("online");
             } else {
               setPeerStatus("offline");
             }
          }
        });
      } else {
        alert("Number not found or offline."); // Replace with soft toast later
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Messages listener
  useEffect(() => {
    if (!chatId) return;

    if (!socketRef.current) {
      socketRef.current = io();
      
      socketRef.current.on("typing-update", ({ userId, isTyping }) => {
        if (userId !== auth.currentUser?.uid) {
          setIsPeerTyping(isTyping);
          // Auto-scroll when typing starts
          setTimeout(() => {
            scrollRef.current?.scrollIntoView({ behavior: "smooth" });
          }, 100);
        }
      });
    }

    socketRef.current.emit("join-chat", chatId);

    const msgsQ = query(
      collection(db, `chats/${chatId}/messages`), 
      orderBy("createdAt", "asc")
    );
    
    const unsubMsgs = onSnapshot(msgsQ, (snap) => {
      const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() })) as any[];
      setMessages(msgs);
      setTimeout(() => {
        scrollRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 100);
      
      // Update read status for incoming messages
      msgs.forEach(m => {
        if (m.senderId !== auth.currentUser?.uid && m.status !== "seen") {
          updateDoc(doc(db, `chats/${chatId}/messages`, m.id), { status: "seen" }).catch(() => {});
        }
      });
    });

    return () => unsubMsgs();
  }, [chatId]);

  const handleType = (text: string) => {
    setMessageText(text);

    if (!socketRef.current || !chatId || !auth.currentUser) return;

    // Emit typing true
    socketRef.current.emit("typing", { chatId, userId: auth.currentUser.uid, isTyping: true });

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

    // Auto-stop typing after 1.5s
    typingTimeoutRef.current = setTimeout(() => {
      socketRef.current?.emit("typing", { chatId, userId: auth.currentUser?.uid, isTyping: false });
    }, 1500);
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageText.trim() || !chatId || !auth.currentUser) return;

    const myUid = auth.currentUser.uid;
    const text = messageText.trim();
    setMessageText("");

    try {
      const chatDocRef = doc(db, "chats", chatId);
      await Promise.all([
        addDoc(collection(chatDocRef, "messages"), {
          senderId: myUid,
          text: text,
          status: "sent",
          createdAt: serverTimestamp()
        }),
        updateDoc(chatDocRef, {
          lastMessageAt: serverTimestamp()
        })
      ]);
      
      // Stop typing immediately when sent
      if (socketRef.current && typingTimeoutRef.current) {
         clearTimeout(typingTimeoutRef.current);
         socketRef.current.emit("typing", { chatId, userId: myUid, isTyping: false });
      }
    } catch (err) {
      console.error("Msg send error:", err);
    }
  };

  const startCall = async (type: "voice" | "video") => {
    if (!peerUid || !auth.currentUser) return;
    
    try {
      const myUid = auth.currentUser.uid;
      // We create the call doc immediately
      const callRef = doc(collection(db, "calls"));
      await setDoc(callRef, {
        callerId: myUid,
        receiverId: peerUid,
        callerPhone: myPhone,
        status: "ringing",
        type,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      setIsCalling(true);
      // We will handle the actual localWebRTC logic inside CallOverlay
      useAppStore.getState().setIncomingCall({ id: callRef.id, callerId: myUid, receiverId: peerUid, callerPhone: myPhone, type, status: "ringing", isInitiator: true });
    } catch (err) {
      console.error("Call error", err);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-900 font-sans">
      <CallOverlay />
      
      {/* Top Security Banner style */}
      <div className="h-10 bg-slate-900 text-white flex items-center justify-between px-6 text-[11px] font-medium tracking-widest uppercase shrink-0">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></div>
            Encrypted Session Active
          </span>
          <span className="opacity-50 px-3 border-l border-slate-700 hidden sm:inline-block">Node ID: {auth.currentUser?.uid.slice(0, 6) || "CONNECTING"}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-orange-400 hidden sm:inline-block">Ephemeral Comms</span>
          <span className="text-white">Me: {myPhone}</span>
        </div>
      </div>

      <header className="h-20 bg-white border-b border-slate-100 flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 shadow-sm border border-slate-200">
            <UserIcon className="w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-base font-bold tracking-tight">GhostCall</span>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></div>
              <span className="text-[11px] text-slate-400 uppercase tracking-widest font-semibold">Online & Secure</span>
            </div>
          </div>
        </div>
        
        {activePeer && (
          <Button variant="ghost" onClick={() => {
            setActivePeer(null);
            if (auth.currentUser) {
              updateDoc(doc(db, "users", auth.currentUser.uid), { focusedChat: null }).catch(() => {});
            }
          }} className="text-slate-500 text-sm">
            End Session
          </Button>
        )}
      </header>

      {activePeer ? (
        <main className="flex-1 flex flex-col overflow-hidden max-w-4xl w-full mx-auto border-x border-slate-200 bg-white shadow-sm mt-4 mb-4 rounded-t-2xl sm:mb-0 sm:rounded-none sm:mt-0 sm:border-t-0 sm:shadow-none">
          <div className="h-20 border-b border-slate-100 flex items-center justify-between px-8 bg-white shrink-0">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-slate-100 flex flex-col items-center justify-center relative overflow-hidden border border-slate-200">
                <span className="text-xs font-mono font-bold text-slate-500">{activePeer.slice(0, 3)}</span>
                {peerStatus === "online" && (
                  <div className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-white" />
                )}
              </div>
              <div>
                <h2 className="text-base font-bold">{activePeer}</h2>
                <div className="flex items-center gap-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full ${peerStatus === "online" ? "bg-emerald-500" : "bg-slate-300"}`}></div>
                  <span className="text-[11px] text-slate-400 uppercase tracking-widest font-semibold">
                    {peerStatus === "online" ? "Direct Link Active" : "Away"}
                  </span>
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-3">
              <Button size="icon" variant="outline" onClick={() => startCall("voice")} className="p-2.5 rounded-full hover:bg-slate-50 text-slate-600 border border-slate-200 transition-all h-10 w-10">
                <PhoneCall className="w-4 h-4" />
              </Button>
              <Button size="icon" onClick={() => startCall("video")} className="p-2.5 rounded-full bg-slate-900 text-white hover:bg-slate-800 transition-all shadow-sm h-10 w-10">
                <Video className="w-4 h-4" />
              </Button>
            </div>
          </div>
          
          <ScrollArea className="flex-1 p-8">
            <div className="space-y-6 flex flex-col pb-4">
              {messages.map((m) => {
                const isMe = m.senderId === auth.currentUser?.uid;
                return (
                  <div key={m.id} className={`flex flex-col gap-1 max-w-[70%] ${isMe ? "ml-auto" : ""}`}>
                    <div className={`px-5 py-3 text-sm leading-relaxed ${
                      isMe 
                        ? "bg-slate-900 text-white rounded-2xl rounded-tr-none shadow-sm" 
                        : "bg-slate-100 text-slate-800 rounded-2xl rounded-tl-none"
                    }`}>
                      {m.text}
                    </div>
                    {isMe && (
                      <span className="text-[10px] text-slate-400 text-right uppercase tracking-widest font-semibold tracking-wider">
                        {m.status === "seen" ? "Read" : m.status === "delivered" ? "Delivered" : "Sent"}
                      </span>
                    )}
                  </div>
                );
              })}
              
              {isPeerTyping && (
                <div className="flex flex-col gap-1 max-w-[70%] animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="px-5 py-3 bg-slate-100/70 text-slate-800 rounded-2xl rounded-tl-none text-sm leading-relaxed italic text-slate-500">
                    Typing...
                  </div>
                </div>
              )}
              <div ref={scrollRef} />
            </div>
          </ScrollArea>
          
          <div className="p-6 border-t border-slate-100 flex items-center gap-4 bg-white">
            <div className={`flex-1 ${peerStatus === "online" ? "bg-slate-100 focus-within:border-slate-200" : "bg-slate-50"} rounded-2xl px-6 py-3 border border-transparent transition-all`}>
              <form onSubmit={handleSendMessage} className="flex gap-2">
                <Input 
                  value={messageText}
                  onChange={(e) => handleType(e.target.value)}
                  placeholder={peerStatus === "online" ? "Type a temporary message..." : `Waiting for ${activePeer} to connect...`}
                  className="w-full bg-transparent border-none focus-visible:ring-0 text-sm placeholder:text-slate-400 text-slate-800 shadow-none h-auto p-0 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={peerStatus !== "online"}
                />
                <button type="submit" disabled={!messageText.trim() || peerStatus !== "online"} className="sr-only">Send</button>
              </form>
            </div>
            <button 
              onClick={handleSendMessage}
              disabled={!messageText.trim() || peerStatus !== "online"}
              className="w-12 h-12 rounded-full bg-slate-900 flex items-center justify-center text-white hover:scale-105 transition-transform shadow-lg disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed"
            >
              <Send className="w-5 h-5 ml-1" />
            </button>
          </div>
        </main>
      ) : (
        <main className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-50">
          <div className="text-center w-full max-w-sm space-y-8">
            <div className="space-y-4">
              <div className="w-20 h-20 mx-auto bg-white border border-slate-200 shadow-sm rounded-full flex flex-col items-center justify-center">
                <PhoneCall className="w-8 h-8 text-slate-300" />
              </div>
              <h2 className="text-xl font-bold tracking-tight text-slate-900">No active comms</h2>
              <p className="text-sm text-slate-500 leading-relaxed">
                Connect securely. All history self-destructs upon termination.
              </p>
            </div>
            
            <form onSubmit={handleFindPeer} className="flex flex-col gap-3">
              <div className="bg-white rounded-2xl px-4 py-3 flex items-center border border-slate-200 focus-within:border-slate-400 focus-within:ring-4 focus-within:ring-slate-100 transition-all shadow-sm">
                <Input 
                  value={peerInput}
                  onChange={(e) => setPeerInput(e.target.value.replace(/\D/g, ""))}
                  placeholder="Enter number to contact..."
                  className="bg-transparent border-none focus-visible:ring-0 text-base placeholder:text-slate-400 text-slate-800 shadow-none h-auto p-0 px-2 flex-1"
                />
              </div>
              <Button type="submit" size="lg" className="w-full rounded-2xl bg-slate-900 text-white hover:bg-slate-800 shadow-lg text-base h-12">
                Connect
              </Button>
            </form>
          </div>
        </main>
      )}
    </div>
  );
}
