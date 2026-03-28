import ReactDOM from "react-dom/client";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import App from "./App";
import "./index.css";

(globalThis as typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: () => Worker;
  };
}).MonacoEnvironment = {
  getWorker: () => new editorWorker()
};

loader.config({ monaco });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <App />
);
