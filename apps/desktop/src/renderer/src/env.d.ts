/// <reference types="vite/client" />
import type { PromptBuilderApi } from "../../shared/ipc.js";

declare global {
  interface Window {
    promptBuilder: PromptBuilderApi;
  }
}

export {};
