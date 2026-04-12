import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("codexDesktop", {
  platform: process.platform
});
