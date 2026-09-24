<div align="center">

# Head in Jar

**Shape an image around a model. Align it with the real world.**

A desktop projection mapping editor with 3D preview, landmark-based image alignment, and a dedicated projector output.

Electron · Three.js · JavaScript

</div>

---

## What it does

- **Preview your model** — import an OBJ, orbit the scene, and inspect its surface with studio lighting.
- **Place your image** — adjust position, scale, and rotation; refine a control grid; draw coverage masks.
- **Match landmarks** — pair points on an image and a model to fit a front-facing texture.
- **Calibrate projection** — tune the projector camera and model pose, then align projected landmarks with a physical object.
- **Receive a live source** — accept one WebRTC video stream with optional audio through the built-in sender page or a WHIP client.
- **Control a separate display** — use Resume, Hold, Blackout, and Stop during setup and projection.
- **Keep your work** — save projects, recover interrupted sessions, and undo or redo edits.

**Status:** early development. Static images and one live WebRTC source are available. Packaged installers are not yet included. Linux with X11/XWayland is the exercised desktop setup; other platforms are not yet verified.

## Get started

Requires **Node.js 22 or newer**, npm, and a desktop session with WebGL support. Connect a projector or second monitor for dedicated output.

```sh
git clone git@github.com:kmrov/headinjar.git
cd headinjar/app
npm ci
npm start
```

The start command builds the renderer before opening the editor. Bring your own OBJ mesh and reference image; no models or image datasets are bundled.

## Your first projection

1. **Import a model and image.** Load an OBJ and a reference image in the editor.
2. **Place the texture.** Use Front mapping for a front-facing image. Adjust Image transform, or open **Front → Align** and pair at least three non-collinear image and model landmarks. Choose **Apply alignment** to fit the texture.
3. **Refine coverage.** Use Grid for local adjustments and Mask to limit coverage. Double-click to finish a mask contour.
4. **Choose an output display.** Select the projector display, then use **Resume** to show the image. Output starts black until explicitly enabled.
5. **Match the physical object.** Open Projector and adjust image offset, model scale and rotation, and camera perspective.
6. **Save the project.** Keep the reference image accessible at its original path.

### Texture mapping modes

| Mode | Use it for |
| --- | --- |
| **Front** | A front-facing image fitted with transforms, a control grid, masks, and landmarks. Hidden and rear-facing surfaces do not receive the image. |
| **Model UV** | A texture atlas authored for the OBJ's original UV coordinates. Front placement controls do not apply in this mode. |

A frontal photograph does not contain the sides or back of an object. An OBJ having UV coordinates does not make an arbitrary photograph a matching texture atlas.

### Physical landmark alignment

Texture alignment fits the image to the digital model. Physical alignment corrects the final projector frame to match a real object.

1. Fix the projector and object in place, then set a reasonable camera and model pose.
2. Under **Projector calibration → Physical alignment**, choose **Use model landmarks**, or use **Add point** to select a point on the model preview.
3. Select a landmark. With output live, a numbered cross appears on the projector.
4. Move its target while watching the physical object. Arrow keys move one output pixel; Shift + arrow moves ten. Target X/Y fields provide numeric control.
5. Repeat for at least three non-collinear points, up to twelve, then choose **Apply alignment**.

**Edit points** returns to the uncorrected preview for editing; **Reset alignment** clears the correction. Invalid or folded warps are rejected. Changes to the camera, model pose, mesh, or output dimensions reset physical calibration; changing the reference image preserves it.

This is operator-guided 2D frame correction. It does not detect the object or automatically solve its 3D pose.

### Live WebRTC input

Open a project with a mesh and select an output display. Under **Source**, choose **WebRTC receiver** and **Start connection server**. The server listens on `127.0.0.1:19840` and stays off until started. It provides two connection methods:

- **Built-in sender:** use **Copy connection link** and open the link on the same computer. The page at `/sender` creates a test canvas video track and optional synthetic audio, then exchanges the offer and answer automatically. The link contains a per-start token in its URL fragment; keep it private.
- **WHIP client:** use **Copy WHIP URL** and **Copy Bearer token**. Send a complete ICE-gathered SDP offer as `POST /whip` with `Content-Type: application/sdp` and `Authorization: Bearer <token>`. The `201` response contains SDP answer and a session `Location`. Apply the answer, then send authenticated `DELETE` to that exact `Location` when finished. Trickle ICE, `PATCH`, and ICE restart are not supported in this version.

For a client on the same computer, the default WHIP endpoint is `http://127.0.0.1:19840/whip`. To use HTTPS, set both `HEADINJAR_TLS_CERT` and `HEADINJAR_TLS_KEY` to certificate and key file paths before starting the app. The certificate must cover `127.0.0.1` and be trusted by the client. A missing or unreadable certificate or key prevents the server from starting. The app does not expose the endpoint on a LAN interface.

Live input does not turn on the projector. Use **Resume** after the stream connects. **Hold** freezes the last frame and mutes audio; **Blackout** and **Stop** show black and mute audio. A connection loss, video resize, or decoded-frame stall disarms output and requires another explicit **Resume**. The editor preview remains based on the reference image.

### Output controls

| Control | Effect |
| --- | --- |
| **Resume** | Enable live rendering on the confirmed display. |
| **Hold** | Freeze the current output frame. |
| **Blackout** | Show black without closing the output window. |
| **Stop** | Disarm output and return to black. |

On Linux, the launcher selects X11/XWayland so the output window can be positioned on the selected monitor. Desktop dimensions are logical display dimensions; Render dimensions are the project's frame buffer size. OS scaling can affect physical pixel correspondence.

## Project files

Projects are saved as JSON with mesh geometry, placement, landmarks, and projector settings. Reference images remain external files addressed by path; keep them alongside your own working assets and update the reference if you move them. Recovery files support restoring newer interrupted work.

## Development

Run these commands from `app/`:

```sh
npm test        # Mapping, project, output, IPC, WebRTC, signaling, and WHIP tests
npm run build   # Bundle the editor and projector renderers
npm run smoke   # Launch Electron and exercise the desktop workflow
```

The smoke test requires a working desktop display and WebGL. It creates temporary synthetic assets and writes screenshots to the ignored `app/test-results/` directory. It checks import, editing, save/recovery, IPC isolation, and output window behavior. It does not validate optical calibration or sustained projector performance.

```text
app/
  electron/     Desktop windows, IPC, and project lifecycle
  renderer/     Editor interface, 3D preview, and projector rendering
  src/          Mapping math, project storage, history, and output state
  scripts/      Build, launch, and desktop smoke test
  test/         Automated unit and integration tests
```

The renderer uses Three.js; desktop integration uses Electron. Fonts and icons are supplied by Inter and Phosphor npm packages. Dependencies retain their respective licenses. No open-source license is granted for this project at this time.
