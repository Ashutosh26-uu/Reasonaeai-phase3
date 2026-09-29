"use client";

import type {
  EditableSpecification,
  StructuredIntent,
} from "@reasonateai/contracts/intent";
import { Button } from "@reasonateai/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@reasonateai/ui/components/card";
import type { ASRAdapter, VisionAdapter } from "@reasonateai/voice-gateway";
import { FileImage, Mic } from "lucide-react";
import { useCallback, useState } from "react";
import { VoiceCapture } from "./voice-capture";
import { WireframeUpload } from "./wireframe-upload";

export type SensoryIntakeResult =
  | { type: "voice"; specification: EditableSpecification }
  | { type: "wireframe"; intent: StructuredIntent };

export interface SensoryIntakeProps {
  asrAdapter?: ASRAdapter;
  onComplete?: (result: SensoryIntakeResult) => void;
  visionAdapter?: VisionAdapter;
}

type InputMethod = "voice" | "wireframe";

export function SensoryIntake({
  asrAdapter,
  visionAdapter,
  onComplete,
}: SensoryIntakeProps) {
  const [activeMethod, setActiveMethod] = useState<InputMethod>("voice");

  // Keep a small wrapper around the specific callbacks
  const handleVoiceComplete = useCallback(
    (spec: EditableSpecification) => {
      if (onComplete) {
        onComplete({ specification: spec, type: "voice" });
      }
    },
    [onComplete]
  );

  const handleWireframeComplete = useCallback(
    (intent: StructuredIntent) => {
      if (onComplete) {
        onComplete({ intent, type: "wireframe" });
      }
    },
    [onComplete]
  );

  const selectVoice = useCallback(() => setActiveMethod("voice"), []);
  const selectWireframe = useCallback(() => setActiveMethod("wireframe"), []);

  return (
    <Card className="mx-auto w-full max-w-2xl border-none bg-transparent shadow-none">
      <CardHeader className="pb-8 text-center">
        <CardTitle className="font-bold text-3xl tracking-tight">
          Project Intake
        </CardTitle>
        <CardDescription className="mt-2 text-base">
          Choose how you would like to describe your project requirements.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Input Method Selector */}
        <fieldset
          aria-label="Input Method Selection"
          className="mb-8 flex flex-col justify-center gap-4 sm:flex-row"
        >
          <Button
            aria-pressed={activeMethod === "voice"}
            className="h-14 max-w-[200px] flex-1"
            onClick={selectVoice}
            variant={activeMethod === "voice" ? "default" : "outline"}
          >
            <Mic className="mr-2 h-5 w-5" />
            Describe your idea
          </Button>
          <Button
            aria-pressed={activeMethod === "wireframe"}
            className="h-14 max-w-[200px] flex-1"
            onClick={selectWireframe}
            variant={activeMethod === "wireframe" ? "default" : "outline"}
          >
            <FileImage className="mr-2 h-5 w-5" />
            Upload a wireframe
          </Button>
        </fieldset>

        {/* Dynamic Surface Rendering */}
        <section
          aria-label={`${activeMethod === "voice" ? "Voice Capture" : "Wireframe Upload"} Surface`}
          aria-live="polite"
          className="mt-6"
        >
          {activeMethod === "voice" ? (
            <VoiceCapture
              asrAdapter={asrAdapter}
              onComplete={handleVoiceComplete}
            />
          ) : (
            <WireframeUpload
              onComplete={handleWireframeComplete}
              visionAdapter={visionAdapter}
            />
          )}
        </section>
      </CardContent>
    </Card>
  );
}
