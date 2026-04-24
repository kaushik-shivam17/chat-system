"use client";

import { useAppStore } from "@/lib/store";
import { Login } from "@/components/Login";
import { Main } from "@/components/Main";

export default function Page() {
  const myPhone = useAppStore((state) => state.myPhone);

  if (!myPhone) {
    return <Login />;
  }

  return <Main />;
}
