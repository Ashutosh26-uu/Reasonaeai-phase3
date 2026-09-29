"use client";

import type {
  EditableSpecification,
  SurfaceError,
  VoiceCaptureResult,
  VoiceCaptureStatus,
} from "@reasonateai/contracts/intent";
import { Button } from "@reasonateai/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@reasonateai/ui/components/card";
import type { ASRAdapter } from "@reasonateai/voice-gateway";
import { MockASRAdapter } from "@reasonateai/voice-gateway";
import { AlertCircle, CheckCircle2, Loader2, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SpecificationEditor } from "./specification-editor";

export interface VoiceCaptureProps {
  asrAdapter?: ASRAdapter | undefined;
  onComplete?: ((spec: EditableSpecification) => void) | undefined;
}

export function VoiceCapture({
  asrAdapter = new MockASRAdapter(),
  onComplete,
}: VoiceCaptureProps) {
  const [status, setStatus] = useState<VoiceCaptureStatus>("idle");
  const [result, setResult] = useState<VoiceCaptureResult | null>(null);
  const [duration, setDuration] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state === "recording"
      ) {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
      }
    };
  }, []);

  const handleStartRecording = useCallback(async () => {
    // Guard against duplicate starts
    if (status === "recording" || status === "processing") {
      return;
    }

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("unsupported");
        setResult({
          error: {
            code: "UNSUPPORTED",
            message: "MediaDevices API not supported",
            userMessage: "Your browser does not support audio recording.",
          },
        });
        return;
      }

      if (typeof MediaRecorder === "undefined") {
        setStatus("unsupported");
        setResult({
          error: {
            code: "MEDIARECORDER_UNSUPPORTED",
            message: "MediaRecorder API not supported",
            userMessage:
              "Your browser does not support audio recording. Please use a modern browser.",
          },
        });
        return;
      }

      setStatus("permission-required");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.onstop = async () => {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
        if (timerRef.current) {
          clearInterval(timerRef.current);
        }

        if (chunksRef.current.length === 0) {
          setStatus("failed");
          setResult({
            error: {
              code: "EMPTY_RECORDING",
              message: "No audio data captured",
              userMessage: "We couldn't capture any audio. Please try again.",
            },
          });
          return;
        }

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        await processAudio(blob);
      };

      mediaRecorder.start();
      setStatus("recording");
      setDuration(0);
      timerRef.current = setInterval(() => {
        setDuration((prev) => prev + 1);
      }, 1000);
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "NotAllowedError" ||
          error.name === "PermissionDeniedError")
      ) {
        setStatus("permission-denied");
        setResult({
          error: {
            code: "PERMISSION_DENIED",
            message: error.message,
            userMessage:
              "Microphone access was denied. Please allow microphone access in your browser to use this feature.",
          },
        });
      } else {
        setStatus("failed");
        setResult({
          error: {
            code: "START_FAILED",
            message: error instanceof Error ? error.message : "Unknown error",
            userMessage:
              "Could not start recording. Please check your microphone.",
          },
        });
      }
    }
  }, [status, asrAdapter]);

  const handleStopRecording = useCallback(() => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === "recording"
    ) {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const processAudio = async (blob: Blob) => {
    setStatus("processing");
    try {
      const response = await asrAdapter.processAudio(blob);

      if (response && "code" in response) {
        setStatus("failed");
        setResult({ error: response as SurfaceError });
      } else {
        setStatus("completed");
        setResult({ specification: response as EditableSpecification });
      }
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setStatus("failed");
      setResult({
        error: {
          code: "PROCESSING_FAILED",
          message:
            error instanceof Error ? error.message : "Unknown processing error",
          userMessage: "Failed to process audio. Please try again.",
        },
      });
    }
  };

  const handleReset = useCallback(() => {
    handleStopRecording();
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }
    chunksRef.current = [];
    setStatus("idle");
    setResult(null);
    setDuration(0);
  }, [handleStopRecording]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const handleContinue = useCallback(() => {
    if (onComplete && result?.specification) {
      onComplete(result.specification);
    }
  }, [onComplete, result]);

  const handleSpecChange = useCallback(
    (spec: EditableSpecification) => {
      if (result) {
        setResult({ ...result, specification: spec });
      }
    },
    [result]
  );

  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Voice Capture</CardTitle>
        <CardDescription>
          Describe your project using your voice
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* State rendering */}
        <div
          aria-live="polite"
          className="flex items-center justify-between rounded-lg border bg-muted/50 p-4"
        >
          <div className="flex items-center gap-3">
            {status === "idle" && (
              <Mic className="size-5 text-muted-foreground" />
            )}
            {status === "recording" && (
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
              </span>
            )}
            {status === "processing" && (
              <Loader2
                className="size-5 animate-spin text-primary"
                data-testid="processing-icon"
              />
            )}
            {status === "completed" && (
              <CheckCircle2 className="size-5 text-green-500" />
            )}
            {(status === "failed" ||
              status === "unsupported" ||
              status.includes("permission")) && (
              <AlertCircle className="size-5 text-destructive" />
            )}

            <div className="flex flex-col">
              <span className="font-medium text-sm capitalize">
                {status.replace("-", " ")}
              </span>
              {status === "recording" && (
                <span
                  className="font-mono text-muted-foreground text-xs"
                  data-testid="duration"
                >
                  <span className="sr-only">Recording duration: </span>
                  <span aria-hidden="true">{formatDuration(duration)}</span>
                </span>
              )}
            </div>
          </div>

          <div className="flex gap-2">
            {status === "idle" || status === "unsupported" ? (
              <Button
                aria-label="Start recording"
                disabled={status === "unsupported"}
                onClick={handleStartRecording}
              >
                <Mic className="mr-2 size-4" /> Record
              </Button>
            ) : null}
            {status === "recording" && (
              <Button
                aria-label="Stop recording"
                onClick={handleStopRecording}
                variant="destructive"
              >
                <Square className="mr-2 size-4 fill-current" /> Stop
              </Button>
            )}
            {(status === "failed" || status.includes("permission")) && (
              <Button
                aria-label="Retry recording"
                onClick={handleReset}
                variant="outline"
              >
                Try Again
              </Button>
            )}
            {status === "completed" && (
              <Button
                aria-label="Record another"
                onClick={handleReset}
                variant="outline"
              >
                Record Another
              </Button>
            )}
          </div>
        </div>

        {/* Error States */}
        {result?.error && (
          <div
            className="rounded-md bg-destructive/10 p-4 text-destructive text-sm"
            role="alert"
          >
            {result.error.userMessage}
          </div>
        )}

        {/* Completed State */}
        {status === "completed" && result?.specification && (
          <div className="mt-6 space-y-4 border-t pt-6">
            <h4 className="font-medium text-muted-foreground text-sm">
              Generated Specification
            </h4>
            <SpecificationEditor
              onChange={handleSpecChange}
              specification={result.specification}
            />
            <div className="flex justify-end pt-4">
              <Button
                aria-label="Continue with specification"
                onClick={handleContinue}
              >
                Accept & Continue
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
