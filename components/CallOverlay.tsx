"use client";

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import { db, auth } from "@/lib/firebase";
import { doc, updateDoc, onSnapshot, collection, addDoc, serverTimestamp } from "firebase/firestore";
import { PhoneOff, Video, Phone, Mic, MicOff, VideoOff } from "lucide-react";
import { Button } from "@/components/ui/button";

const servers = {
  iceServers: [
    { urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] }
  ],
  iceCandidatePoolSize: 10,
};

export function CallOverlay() {
  const { incomingCall, setIncomingCall, isCalling, setIsCalling } = useAppStore();
  const [micOn, setMicOn] = useState(true);
  const [videoOn, setVideoOn] = useState(true);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const remoteStream = useRef<MediaStream | null>(null);

  // Clean up function inside CallOverlay
  const terminateCall = async () => {
    if (incomingCall?.id && auth.currentUser) {
      try {
        await updateDoc(doc(db, "calls", incomingCall.id), { 
          status: "ended",
          updatedAt: serverTimestamp() 
        });
      } catch (e) { console.error(e); }
    }
    pc.current?.close();
    pc.current = null;
    localStream.current?.getTracks().forEach((t) => t.stop());
    localStream.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    setIncomingCall(null);
    setIsCalling(false);
  };

  useEffect(() => {
    if (!incomingCall) return;

    const callDocRef = doc(db, "calls", incomingCall.id);
    
    // Status watcher for entire call (handle rejects/ends remotely)
    const unsub = onSnapshot(callDocRef, (snap) => {
      const data = snap.data();
      if (!data) return;
      if (data.status === "rejected" || data.status === "ended" || data.status === "missed") {
        terminateCall(); // cleanup
      }
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingCall?.id]);

  const initLocalStream = async (type: "voice" | "video") => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: type === "video",
        audio: true
      });
      localStream.current = stream;
      if (localVideoRef.current && type === "video") {
        localVideoRef.current.srcObject = stream;
      }
      return stream;
    } catch (err) {
      console.error("Camera/Mic error", err);
      // fallback
      return null;
    }
  };

  const setupWebRTC = async (callId: string, isInitiator: boolean, type: "voice" | "video") => {
    pc.current = new RTCPeerConnection(servers);
    
    // Setup remote stream holding area
    remoteStream.current = new MediaStream();
    if (remoteVideoRef.current && type === "video") {
      remoteVideoRef.current.srcObject = remoteStream.current;
    }

    pc.current.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        remoteStream.current?.addTrack(track);
      });
    };

    const stream = await initLocalStream(type);
    if (stream) {
      stream.getTracks().forEach((track) => {
        pc.current?.addTrack(track, stream);
      });
    }

    const callDocRef = doc(db, "calls", callId);
    const callerCandidatesColl = collection(callDocRef, "callerCandidates");
    const receiverCandidatesColl = collection(callDocRef, "receiverCandidates");

    pc.current.onicecandidate = async (event) => {
      if (event.candidate) {
        await addDoc(isInitiator ? callerCandidatesColl : receiverCandidatesColl, {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex
        });
      }
    };

    if (isInitiator) {
      const offerDescription = await pc.current.createOffer();
      await pc.current.setLocalDescription(offerDescription);
      
      const offer = {
        sdp: offerDescription.sdp,
        type: offerDescription.type,
      };

      await updateDoc(callDocRef, { offer, updatedAt: serverTimestamp() });

      // Listen for remote answer
      onSnapshot(callDocRef, (snap) => {
        const data = snap.data();
        if (!pc.current?.currentRemoteDescription && data?.answer) {
          const answerDescription = new RTCSessionDescription(data.answer);
          pc.current?.setRemoteDescription(answerDescription);
        }
      });

      // Listen for remote candidates
      onSnapshot(receiverCandidatesColl, (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === "added") {
            const data = change.doc.data();
            pc.current?.addIceCandidate(new RTCIceCandidate(data));
          }
        });
      });

    } else {
      // Is Receiver
      onSnapshot(callDocRef, async (snap) => {
        const data = snap.data();
        if (!pc.current) return;

        if (data?.offer && !pc.current.currentRemoteDescription) {
          const offerDescription = new RTCSessionDescription(data.offer);
          await pc.current.setRemoteDescription(offerDescription);
          
          const answerDescription = await pc.current.createAnswer();
          await pc.current.setLocalDescription(answerDescription);
          
          const answer = {
            sdp: answerDescription.sdp,
            type: answerDescription.type,
          };
          await updateDoc(callDocRef, { answer, status: "accepted", updatedAt: serverTimestamp() });
        }
      });

      // Listen for caller candidates
      onSnapshot(callerCandidatesColl, (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === "added") {
            const data = change.doc.data();
            pc.current?.addIceCandidate(new RTCIceCandidate(data));
          }
        });
      });
    }
  };

  const handleAccept = async () => {
    if (!incomingCall) return;
    setIsCalling(true);
    await setupWebRTC(incomingCall.id, false, incomingCall.type);
  };

  const handleReject = async () => {
    if (!incomingCall) return;
    await updateDoc(doc(db, "calls", incomingCall.id), { 
      status: "rejected",
      updatedAt: serverTimestamp() 
    });
    terminateCall();
  };

  // If we initiate the call, we run setup immediately
  useEffect(() => {
    if (incomingCall?.isInitiator && isCalling && !pc.current) {
      setupWebRTC(incomingCall.id, true, incomingCall.type);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingCall, isCalling]);

  const toggleMic = () => {
    if (localStream.current) {
      localStream.current.getAudioTracks()[0].enabled = !micOn;
      setMicOn(!micOn);
    }
  };

  const toggleVideo = () => {
    if (localStream.current && incomingCall?.type === "video") {
      localStream.current.getVideoTracks()[0].enabled = !videoOn;
      setVideoOn(!videoOn);
    }
  };

  if (!incomingCall) return null;

  const isRingingForReceiver = incomingCall.status === "ringing" && !incomingCall.isInitiator;
  const isVideo = incomingCall.type === "video";

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/90 backdrop-blur-md flex flex-col items-center justify-center p-4 font-sans">
      {/* Video feeds */}
      {isVideo && !isRingingForReceiver && (
        <div className="absolute inset-0 grid grid-cols-1 md:grid-cols-2 gap-4 p-8 mt-16 max-h-[70vh]">
          <div className="relative rounded-3xl overflow-hidden bg-white border border-slate-200 shadow-xl">
            <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover scale-x-[-1]" />
            <div className="absolute bottom-6 left-6 px-4 py-2 bg-slate-900/80 backdrop-blur text-white rounded-full text-xs font-semibold uppercase tracking-wider">You</div>
          </div>
          <div className="relative rounded-3xl overflow-hidden bg-white border border-slate-200 shadow-xl">
            <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
            <div className="absolute bottom-6 left-6 px-4 py-2 bg-slate-900/80 backdrop-blur text-white rounded-full text-xs font-semibold uppercase tracking-wider">
              {incomingCall.callerPhone || "Peer"}
            </div>
          </div>
        </div>
      )}

      {/* Center status for voice/ringing */}
      {(!isVideo || isRingingForReceiver) && (
        <div className="animate-in fade-in zoom-in duration-300 relative z-10 flex flex-col items-center">
          <div className="w-28 h-28 rounded-full bg-white shadow-xl flex items-center justify-center mb-8 border border-slate-100">
            {isVideo ? <Video className="w-12 h-12 text-slate-400" /> : <Phone className="w-12 h-12 text-slate-400" />}
          </div>
          <div className="px-4 py-1.5 bg-orange-50/10 border border-orange-500/20 text-orange-400 rounded-full text-[10px] font-bold uppercase tracking-widest mb-4">
            Security Active
          </div>
          <h2 className="text-4xl font-bold tracking-tight text-white mb-3">
            {incomingCall.callerPhone}
          </h2>
          <p className="text-slate-400 text-sm tracking-widest uppercase font-semibold">
            {incomingCall.status === "ringing" ? "Incoming Connection..." : "Live Audio Feed"}
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="absolute bottom-12 left-0 right-0 flex justify-center gap-6 z-20">
        {isRingingForReceiver ? (
          <>
            <Button size="icon" className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 border-none shadow-xl" onClick={handleReject}>
              <PhoneOff className="w-6 h-6 text-white" />
            </Button>
            <Button size="icon" className="w-16 h-16 rounded-full bg-emerald-500 hover:bg-emerald-600 border-none shadow-xl" onClick={handleAccept}>
              {isVideo ? <Video className="w-6 h-6 text-white" /> : <Phone className="w-6 h-6 text-white" />}
            </Button>
          </>
        ) : (
          <>
            <Button size="icon" variant="outline" className="w-14 h-14 rounded-full border-slate-700 bg-slate-800/80 backdrop-blur hover:bg-slate-700 hover:text-white text-slate-200" onClick={toggleMic}>
              {micOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5 text-red-400" />}
            </Button>
            {isVideo && (
              <Button size="icon" variant="outline" className="w-14 h-14 rounded-full border-slate-700 bg-slate-800/80 backdrop-blur hover:bg-slate-700 hover:text-white text-slate-200" onClick={toggleVideo}>
                {videoOn ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5 text-red-400" />}
              </Button>
            )}
            <Button size="icon" className="w-14 h-14 rounded-full bg-red-500 hover:bg-red-600 border-none shadow-xl ml-2" onClick={terminateCall}>
              <PhoneOff className="w-5 h-5 text-white" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
