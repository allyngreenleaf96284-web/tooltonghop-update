import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export async function readWindowsWorkArea() {
  if (process.platform !== "win32") return null;
  const script = `Add-Type -AssemblyName System.Windows.Forms
$display = [System.Windows.Forms.Screen]::PrimaryScreen
$area = $display.WorkingArea
@{left=$area.Left;top=$area.Top;width=$area.Width;height=$area.Height} | ConvertTo-Json -Compress`;
  const { stdout } = await executeFile("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")
  ], { windowsHide: true, timeout: 10000, maxBuffer: 8192 });
  return JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
}

function validArea(area) {
  return area && [area.left, area.top, area.width, area.height].every(Number.isFinite)
    && area.width > 0 && area.height > 0;
}

// All workers share one OS work area. A profile's screen fingerprint must not
// determine its native window position or the other workers' viewport sizes.
export function createLoginDisplay({ readWorkArea = readWindowsWorkArea, onFallback = () => {} } = {}) {
  let areaPromise;
  return {
    reset() { areaPromise = null; },
    area(page) {
      if (!areaPromise) areaPromise = (async () => {
        try {
          const area = await readWorkArea();
          if (validArea(area)) return Object.freeze({ ...area });
        } catch (error) { onFallback(error); }
        // If the OS is unavailable, read exactly one browser, rather than
        // mixing the different screen values of all running profiles.
        const area = await page.evaluate(() => ({ left: screen.availLeft || 0, top: screen.availTop || 0,
          width: screen.availWidth, height: screen.availHeight })).catch(() => null);
        return Object.freeze(validArea(area) ? area : { left: 0, top: 0, width: 1920, height: 1040 });
      })();
      return areaPromise;
    }
  };
}
