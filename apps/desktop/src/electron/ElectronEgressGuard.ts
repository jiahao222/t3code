import {
  checkOutboundUrlPolicy,
  installLocalEgressGuard,
} from "@t3tools/shared/localEgressGuard";
import * as Electron from "electron";

const guardedSessions = new WeakSet<Electron.Session>();
let electronGuardInstalled = false;

export function applySessionEgressGuard(targetSession: Electron.Session): void {
  if (guardedSessions.has(targetSession)) {
    return;
  }
  guardedSessions.add(targetSession);

  void targetSession.setProxy({ mode: "direct" }).catch(() => {});

  targetSession.webRequest.onBeforeRequest(
    { urls: ["*://*/*", "ws://*/*", "wss://*/*"] },
    (details, callback) => {
      try {
        const parsed = new URL(details.url);
        if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::]" || parsed.hostname === "::") {
          if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
            callback({ cancel: true });
            return;
          }
          parsed.hostname = "localhost";
          callback({ redirectURL: parsed.toString() });
          return;
        }
        const verdict = checkOutboundUrlPolicy(parsed, "desktop", details.method);
        callback(verdict.allowed ? {} : { cancel: true });
      } catch {
        callback({ cancel: true });
      }
    },
  );
}

export function installElectronEgressGuard(): void {
  installLocalEgressGuard("desktop");

  if (electronGuardInstalled) {
    return;
  }
  electronGuardInstalled = true;

  // Must run before app.whenReady so Chromium's network service starts with strict resolver rules.
  try {
    Electron.app.commandLine.appendSwitch("no-proxy-server");
    Electron.app.commandLine.appendSwitch("disable-background-networking");
    Electron.app.commandLine.appendSwitch("disable-component-update");
    Electron.app.commandLine.appendSwitch("disable-domain-reliability");
    Electron.app.commandLine.appendSwitch("disable-sync");
    Electron.app.commandLine.appendSwitch(
      "host-resolver-rules",
      "MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1 , EXCLUDE ::1 , EXCLUDE cdn.agentclientprotocol.com",
    );
  } catch {}

  Electron.app.on("session-created", (ses) => {
    applySessionEgressGuard(ses);
  });

  Electron.app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, navigationUrl) => {
      if (!checkOutboundUrlPolicy(navigationUrl, "desktop", "GET").allowed) {
        event.preventDefault();
      }
    });
    contents.on("will-redirect", (event, redirectUrl) => {
      if (!checkOutboundUrlPolicy(redirectUrl, "desktop", "GET").allowed) {
        event.preventDefault();
      }
    });
  });

  void Electron.app.whenReady().then(() => {
    applySessionEgressGuard(Electron.session.defaultSession);
  });
}
