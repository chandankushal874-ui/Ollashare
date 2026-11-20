import { contextBridge } from "electron";

contextBridge.exposeInMainWorld(
    "miraDesktop",
    Object.freeze({
        platform: process.platform,
        isDesktop: true,
    }),
);
