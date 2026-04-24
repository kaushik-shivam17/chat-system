"use client";

import { useState } from "react";
import { useAppStore } from "@/lib/store";
import { loginAnonymously, db, auth } from "@/lib/firebase";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Phone } from "lucide-react";

export function Login() {
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const setMyPhone = useAppStore((state) => state.setMyPhone);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phone.length < 3) return;
    setLoading(true);
    setErrorMsg(null);
    
    try {
      await loginAnonymously();
      if (!auth.currentUser) throw new Error("Auth failed");
      
      const userId = auth.currentUser.uid;
      
      // Upsert user profile
      await setDoc(doc(db, "users", userId), {
        phoneNumber: phone,
        status: "online",
        lastSeen: serverTimestamp()
      });
      
      setMyPhone(phone);
    } catch (err: any) {
      console.error(err);
      if (err.code === "auth/admin-restricted-operation") {
        setErrorMsg("Please enable 'Anonymous' authentication in your Firebase Console (Build > Authentication > Sign-in method).");
      } else {
        setErrorMsg(err.message || "Failed to authenticate.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 font-sans p-4">
      <Card className="w-full max-w-sm bg-white border-slate-200 shadow-sm text-slate-900">
        <CardHeader className="space-y-1 items-center text-center">
          <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mb-2 text-slate-400">
            <Phone className="w-6 h-6" />
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">GhostCall</CardTitle>
          <CardDescription className="text-slate-500">
            Enter your ephemeral number to start.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <Input
              type="tel"
              placeholder="e.g. 12345"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
              className="bg-slate-100 border-transparent focus-visible:ring-0 focus-visible:border-slate-200 text-center text-lg h-12 text-slate-900 placeholder:text-slate-400 transition-all rounded-2xl"
              autoFocus
              maxLength={15}
            />
            <Button
              type="submit"
              className="w-full bg-slate-900 text-white hover:bg-slate-800 h-12 font-semibold rounded-2xl transition-all"
              disabled={loading || phone.length < 3}
            >
              {loading ? "Connecting..." : "Connect"}
            </Button>
            {errorMsg && (
              <div className="text-sm text-red-500 text-center font-medium bg-red-50 p-3 rounded-xl border border-red-100">
                {errorMsg}
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
