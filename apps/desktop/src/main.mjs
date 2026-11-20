import { app, BrowserWindow, session, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    isAllowedPermission,
    isSafeExternalUrl,
    isTrustedNavigation,
    resolveAppUrl,
} from "./security.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const appUrl = resolveAppUrl();
let mainWindow = null;

app.enableSandbox();

function configureSession() {
    session.defaultSession.setPermissionCheckHandler(
        (_webContents, permission, requestingOrigin) =>
            isAllowedPermission(permission, requestingOrigin, appUrl),
    );
    session.defaultSession.setPermissionRequestHandler(
        (webContents, permission, callback, details) => {
            const requestingUrl = details.requestingUrl || webContents.getURL();
            callback(isAllowedPermission(permission, requestingUrl, appUrl));
        },
    );
}

function createWindow() {
    mainWindow = new BrowserWindow({
        title: "Mira",
        width: 1440,
        height: 960,
        minWidth: 1024,
        minHeight: 720,
        backgroundColor: "#09090b",
        show: false,
        webPreferences: {
            preload: path.join(directory, "preload.mjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            spellcheck: true,
        },
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (isTrustedNavigation(url, appUrl)) {
            void mainWindow?.loadURL(url);
        } else if (isSafeExternalUrl(url)) {
            void shell.openExternal(url);
        }
        return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
        if (isTrustedNavigation(url, appUrl)) return;
        event.preventDefault();
        if (isSafeExternalUrl(url)) void shell.openExternal(url);
    });
    mainWindow.webContents.on("will-attach-webview", (event) => {
        event.preventDefault();
    });
    mainWindow.once("ready-to-show", () => mainWindow?.show());
    mainWindow.on("closed", () => {
        mainWindow = null;
    });
    void mainWindow.loadURL(appUrl.href);
}

app.whenReady().then(() => {
    configureSession();
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
