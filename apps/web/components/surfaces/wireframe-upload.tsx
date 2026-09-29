"use client";

import type {
  StructuredIntent,
  SurfaceError,
  WireframeUploadResult,
  WireframeUploadStatus,
} from "@reasonateai/contracts/intent";
import { Button } from "@reasonateai/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@reasonateai/ui/components/card";
import type { VisionAdapter } from "@reasonateai/voice-gateway";
import { MockVisionAdapter } from "@reasonateai/voice-gateway";
import {
  AlertCircle,
  CheckCircle2,
  FileImage,
  Loader2,
  Upload,
  X,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { IntentDisplay } from "./intent-display";

export interface WireframeUploadProps {
  className?: string | undefined;
  onComplete?: ((intent: StructuredIntent) => void) | undefined;
  visionAdapter?: VisionAdapter | undefined;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const SUPPORTED_TYPES = ["image/png", "image/jpeg", "image/webp"];

export function WireframeUpload({
  visionAdapter = new MockVisionAdapter(),
  onComplete,
  className,
}: WireframeUploadProps) {
  const [status, setStatus] = useState<WireframeUploadStatus>("empty");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [result, setResult] = useState<WireframeUploadResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);

  useEffect(
    () => () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    },
    [previewUrl]
  );

  const handleFileValidation = (selectedFile: File): SurfaceError | null => {
    if (!selectedFile) {
      return {
        code: "EMPTY_FILE",
        message: "No file selected",
        userMessage: "Please select a file to upload.",
      };
    }
    if (!SUPPORTED_TYPES.includes(selectedFile.type)) {
      return {
        code: "UNSUPPORTED_TYPE",
        message: `Unsupported file type: ${selectedFile.type}`,
        userMessage: "Please upload a PNG, JPEG, or WebP image.",
      };
    }
    if (selectedFile.size > MAX_FILE_SIZE) {
      return {
        code: "FILE_TOO_LARGE",
        message: "File exceeds 5MB limit",
        userMessage: "File size must be less than 5MB.",
      };
    }
    if (selectedFile.size === 0) {
      return {
        code: "EMPTY_FILE",
        message: "File is empty",
        userMessage: "The selected file is empty.",
      };
    }
    return null;
  };

  const handleFileSelection = useCallback(
    (selectedFile: File) => {
      const error = handleFileValidation(selectedFile);
      if (error) {
        setStatus("unsupported"); // or failed
        setResult({ error });
        setFile(null);
        return;
      }

      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }

      setFile(selectedFile);
      setPreviewUrl(URL.createObjectURL(selectedFile));
      setStatus("selected");
      setResult(null);
    },
    [previewUrl]
  );

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFile = e.target.files?.[0];
      if (!selectedFile) {
        return;
      }

      handleFileSelection(selectedFile);
    },
    [handleFileSelection]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const droppedFile = e.dataTransfer.files?.[0];
      if (droppedFile) {
        handleFileSelection(droppedFile);
      }
    },
    [handleFileSelection]
  );

  const clearFile = useCallback(() => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setFile(null);
    setPreviewUrl(null);
    setStatus("empty");
    setResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [previewUrl]);

  const processImage = useCallback(async () => {
    if (!file || processingRef.current) {
      return;
    }

    processingRef.current = true;
    setStatus("processing");
    try {
      const response = await visionAdapter.processImage(file);

      if (response && "code" in response) {
        setStatus("failed");
        setResult({ error: response as SurfaceError });
      } else {
        setStatus("completed");
        setResult({ intent: response as StructuredIntent });
      }
    } catch (error) {
      setStatus("failed");
      setResult({
        error: {
          code: "PROCESSING_FAILED",
          message:
            error instanceof Error ? error.message : "Unknown processing error",
          userMessage: "Failed to process the wireframe. Please try again.",
        },
      });
    } finally {
      processingRef.current = false;
    }
  }, [file, visionAdapter]);

  const handleContinue = useCallback(() => {
    if (result?.intent && onComplete) {
      onComplete(result.intent);
    }
  }, [result?.intent, onComplete]);

  const handleUploadAreaClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) {
      return "0 Bytes";
    }
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
  };

  return (
    <Card className={`mx-auto w-full max-w-2xl ${className || ""}`}>
      <CardHeader>
        <CardTitle>Wireframe Upload</CardTitle>
        <CardDescription>
          Upload a wireframe image to generate specifications
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Status Indicator */}
        <div
          aria-live="polite"
          className="flex items-center gap-3 rounded-lg border bg-muted/50 p-4"
        >
          {status === "empty" && (
            <Upload className="size-5 text-muted-foreground" />
          )}
          {status === "selected" && (
            <FileImage className="size-5 text-primary" />
          )}
          {(status === "uploading" || status === "processing") && (
            <Loader2
              className="size-5 animate-spin text-primary"
              data-testid="processing-icon"
            />
          )}
          {status === "completed" && (
            <CheckCircle2 className="size-5 text-green-500" />
          )}
          {(status === "failed" || status === "unsupported") && (
            <AlertCircle className="size-5 text-destructive" />
          )}

          <div className="flex flex-col">
            <span className="font-medium text-sm capitalize">{status}</span>
          </div>
        </div>

        {/* Upload Area */}
        {(status === "empty" ||
          status === "unsupported" ||
          status === "failed") && (
          <button
            aria-label="Upload wireframe area"
            className="w-full cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={handleUploadAreaClick}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            type="button"
          >
            <Upload className="mx-auto mb-4 size-10 text-muted-foreground" />
            <p className="mb-1 font-medium text-sm">
              Click or drag wireframe here
            </p>
            <p className="text-muted-foreground text-xs">
              Supports PNG, JPEG, WebP up to 5MB
            </p>
            <input
              accept="image/png, image/jpeg, image/webp"
              aria-label="File input"
              className="hidden"
              onChange={onFileChange}
              ref={fileInputRef}
              type="file"
            />
          </button>
        )}

        {/* Error States */}
        {result?.error && (
          <div
            className="rounded-md bg-destructive/10 p-4 text-destructive text-sm"
            role="alert"
          >
            {result.error.userMessage}
          </div>
        )}

        {/* Selected File Details */}
        {(status === "selected" ||
          status === "processing" ||
          status === "uploading" ||
          status === "completed") &&
          file && (
            <div className="space-y-4 rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 overflow-hidden">
                  <FileImage className="size-8 shrink-0 text-primary" />
                  <div className="truncate">
                    <p className="truncate font-medium text-sm">{file.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {formatBytes(file.size)} • {file.type}
                    </p>
                  </div>
                </div>

                {status === "selected" && (
                  <Button
                    aria-label="Remove file"
                    onClick={clearFile}
                    size="icon"
                    variant="ghost"
                  >
                    <X className="size-4" />
                  </Button>
                )}
              </div>

              {previewUrl && (
                <div className="relative aspect-video overflow-hidden rounded-md border bg-muted">
                  <img
                    alt={`Preview of ${file.name}`}
                    className="h-full w-full object-contain"
                    height={450}
                    src={previewUrl}
                    width={800}
                  />
                </div>
              )}

              {status === "selected" && (
                <div className="flex justify-end pt-2">
                  <Button aria-label="Process wireframe" onClick={processImage}>
                    Process Wireframe
                  </Button>
                </div>
              )}
            </div>
          )}

        {/* Completed State Output */}
        {status === "completed" && result?.intent && (
          <div className="mt-6 space-y-4 border-t pt-6">
            <h4 className="font-medium text-muted-foreground text-sm">
              Extracted Intent
            </h4>
            <IntentDisplay intent={result.intent} />
          </div>
        )}
      </CardContent>

      {status === "completed" && (
        <CardFooter className="flex justify-between border-t p-6">
          <Button
            aria-label="Upload another"
            onClick={clearFile}
            variant="outline"
          >
            Upload Another
          </Button>
          <Button aria-label="Continue with intent" onClick={handleContinue}>
            Accept & Continue
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
