import { cn as mergeClasses } from "cn";

export function cn(...inputs: Parameters<typeof mergeClasses>): string {
  return mergeClasses(...inputs);
}
