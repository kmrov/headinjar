<div align="center">

# Head in Jar 🫙

Fit an image to a 3D model, then line it up with the object you're projecting onto.

Head in Jar is a desktop projection mapping editor. You can work with a still image or a live video feed, inspect the result in 3D, and send it to a separate display.

Electron · Three.js · JavaScript

</div>

---

## In the editor

- Import an OBJ, orbit around it, and check the surface in the studio-lit 3D preview.
- Move, scale, and rotate an image. Use the grid and masks when the simple fit needs help.
- Pair landmarks on the image and model to fit a front-facing texture.
- Tune the projector camera and model pose, then align projected points with a physical object.
- Bring in one WebRTC video stream, with optional audio, from the built-in sender page or a WHIP client.
- Control the second display with **Resume**, **Hold**, **Blackout**, and **Stop**.
- Save your project, recover an interrupted session, and undo or redo edits.

This is still early software. You can use static images or one live WebRTC source. The desktop setup has been tested on Linux with X11/XWayland. A macOS user has opened the unsigned package, but physical projector behavior on macOS still needs a real-device check.

## Downloads

Versioned builds are published on the [Releases page](https://github.com/kmrov/headinjar/releases): AppImage and `.deb` for Linux x64, plus `.dmg` and `.zip` for both Intel and Apple Silicon Macs. Bring your own OBJ and image; no model or texture is bundled.

### macOS first launch

The macOS packages are currently unsigned and unnotarized. Download the package for your Mac from the official Releases page, copy **Head in Jar.app** to Applications, and try opening it. If macOS offers **Open Anyway** in System Settings → Privacy & Security, follow [Apple's instructions](https://support.apple.com/en-us/102445).

If macOS instead says the app is “damaged” and offers no **Open Anyway** button, a user has confirmed that clearing the download quarantine from this trusted copy allows it to open:

```sh
xattr -dr com.apple.quarantine "/Applications/Head in Jar.app"
```

This removes Gatekeeper's download check for that copy; it does not verify the package or sign the app. Use it only for an app you obtained directly from this project's Releases page and trust. If the `.dmg` itself will not open, download it again instead. Signing and notarization are needed to avoid this manual step in future releases.

## Get started 🚀

Requires **Node.js 22 or newer**, npm, and a desktop session with WebGL support. Connect a projector or second monitor for dedicated output.

```sh
git clone git@github.com:kmrov/headinjar.git
cd headinjar/app
npm ci
npm start
```

`npm start` builds the renderer and opens the editor. Bring an OBJ mesh and a reference image of your own; the repository does not bundle either.

Start with the [illustrated beginner tutorial](docs/tutorial.md). Its screenshots were captured with local assets; the OBJ and texture themselves are not distributed.

## Your first projection 🎯

1. **Import a model and image.** Load an OBJ and a reference image in the editor.
2. **Place the texture.** Use Front mapping for a front-facing image. Adjust **Image position**, or open **Front → Align** and pair at least three non-collinear image and model landmarks. Choose **Apply alignment** to fit the texture.
3. **Refine coverage.** Use Grid for local adjustments and Mask to limit coverage. Double-click to finish a mask contour.
4. **Choose an output display.** Select the projector display and open black output, then use **Resume** to show the image. Output starts black until explicitly enabled.
5. **Match the physical object.** Open **Projector calibration** and adjust image offset, model scale and rotation, and camera perspective.
6. **Save the project.** Keep the reference image accessible at its original path.

For precise landmark placement in **Front → Align**, zoom the source image and model independently with the mouse wheel at the cursor. Middle-drag to pan either view. **Fit source** resets the image; **Fit view** resets the model. These view changes do not alter the saved texture placement or projector calibration.

### Texture mapping modes

| Mode | Use it for |
| --- | --- |
| **Front** | A front-facing image fitted with transforms, a control grid, masks, and landmarks. Hidden and rear-facing surfaces do not receive the image. |
| **Model UV** | A texture atlas authored for the OBJ's original UV coordinates. Front placement controls do not apply in this mode. |

A front photo cannot show the sides or back of an object. And if an OBJ has UV coordinates, a random photo still will not match its texture atlas.

### Physical landmark alignment

Texture alignment fits the image to the digital model. Physical alignment corrects the final projector frame to match a real object.

1. Fix the projector and object in place, then set a reasonable camera and model pose.
2. Under **Projector calibration → Projection alignment points**, choose **Use model landmarks**, or use **Add point** to select a point on the model preview.
3. Select a landmark. With output live, a numbered cross appears on the projector.
4. Move its target while watching the physical object. Arrow keys move one output pixel; Shift + arrow moves ten. Target X/Y fields provide numeric control.
5. Repeat for at least three non-collinear points, up to twelve, then choose **Apply alignment**.

**Edit points** returns to the uncorrected preview for editing; **Reset alignment** clears the correction. Invalid or folded warps are rejected. Changes to the camera, model pose, mesh, or output dimensions reset physical calibration; changing the reference image preserves it.

This is operator-guided 2D frame correction. It does not detect the object or automatically solve its 3D pose.

### Live WebRTC input 📡

Under **Source type**, choose **Live video · WebRTC** and **Start connection server**. The image controls give way to the video preview and connection controls. The server listens on `127.0.0.1:19840` and stays off until started. You can connect and inspect live video in the editor before opening an output display or importing a mesh. After importing a mesh, the same live frame appears on the model and in **Front → Align**. **Freeze preview** holds the editor and alignment view while the stream keeps running; it does not freeze the projector. The server provides two connection methods:

- **Built-in sender:** use **Copy link** and open the link on the same computer. The page at `/sender` creates a test canvas video track and optional synthetic audio, then exchanges the offer and answer automatically. The link contains a per-start token in its URL fragment; keep it private.
- **WHIP client:** use **Copy WHIP URL** and **Copy Bearer token**. Send a complete ICE-gathered SDP offer as `POST /whip` with `Content-Type: application/sdp` and `Authorization: Bearer <token>`. The `201` response contains SDP answer and a session `Location`. Apply the answer, then send authenticated `DELETE` to that exact `Location` when finished. Trickle ICE, `PATCH`, and ICE restart are not supported in this version.

For a client on the same computer, the default WHIP endpoint is `http://127.0.0.1:19840/whip`. To use HTTPS, set both `HEADINJAR_TLS_CERT` and `HEADINJAR_TLS_KEY` to certificate and key file paths before starting the app. The certificate must cover `127.0.0.1` and be trusted by the client. A missing or unreadable certificate or key prevents the server from starting. The app does not expose the endpoint on a LAN interface.

Live input does not turn on the projector. Select a display and use **Resume** after the stream connects. **Hold** freezes the last projected frame and mutes audio; **Blackout** and **Stop** show black and mute audio. Closing or reopening Output keeps the WebRTC source connected. A connection loss, video resize, or decoded-frame stall disarms output and requires another explicit **Resume**. Switching back to **Reference image** replaces the live editor preview with the saved reference image.

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

## Development 🛠️

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

### Publish a release

The [release workflow](.github/workflows/release.yml) runs when a version tag such as `v0.1.0` is pushed. It sets the package version from the tag, runs tests, builds Linux and macOS packages, and publishes the GitHub Release only after all six packages are available. To publish the next version from the public checkout:

```sh
git tag v0.2.0
git push origin v0.2.0
```

Use a new `vMAJOR.MINOR.PATCH` tag for each release. Regular pushes to `main` build all three platforms and keep packages as temporary Actions artifacts; they do not create releases. To check Linux packaging locally, run `npm run build` and `npm run package -- --linux --x64` from `app/`; package files appear in ignored `app/release/`. macOS packaging runs on GitHub's macOS runners. Installing a Developer ID certificate and enabling signing/notarization is a separate release step; the current macOS packages do not claim those protections.
