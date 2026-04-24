import { create } from 'zustand';

interface AppState {
  myPhone: string | null;
  setMyPhone: (phone: string | null) => void;
  activePeer: string | null;
  setActivePeer: (phone: string | null) => void;
  isCalling: boolean;
  setIsCalling: (isCalling: boolean) => void;
  incomingCall: any | null;
  setIncomingCall: (call: any | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  myPhone: null,
  setMyPhone: (phone) => set({ myPhone: phone }),
  activePeer: null,
  setActivePeer: (phone) => set({ activePeer: phone }),
  isCalling: false,
  setIsCalling: (isCalling) => set({ isCalling }),
  incomingCall: null,
  setIncomingCall: (call) => set({ incomingCall: call }),
}));
