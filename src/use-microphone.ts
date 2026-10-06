import { useEffect, useRef, useState } from "react";
import { MicrophoneInput, type MicrophoneSnapshot } from "./microphone";
export function useMicrophone() {
  const [snapshot, setSnapshot] = useState<MicrophoneSnapshot>({ status: "off", analyser: null, error: "" });
  const controller = useRef<MicrophoneInput | null>(null);
  if (!controller.current) controller.current = new MicrophoneInput(setSnapshot);
  useEffect(() => () => controller.current?.stop(), []);
  const toggle = () => ["live", "requesting"].includes(controller.current!.snapshot.status)
    ? controller.current!.stop() : void controller.current!.start();
  return { ...snapshot, toggle, stop: () => controller.current!.stop() };
}
