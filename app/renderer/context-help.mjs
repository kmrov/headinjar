const HELP = {
  'editor-modes': {
    title: 'Editor modes',
    lines: [
      { name: 'Image placement', detail: ' aligns an image with the digital model.' },
      { name: 'Projector calibration', detail: ' adjusts the output on the real surface after you choose a display.' },
    ],
  },
  webrtc: {
    title: 'Live video · WebRTC',
    lines: [
      'Start the connection server, copy the sender link, and open it in a browser on this computer.',
      'A connected source appears in the preview. Start projection separately when you are ready.',
    ],
  },
  align: {
    title: 'Align image and model',
    lines: [
      'Click a point on the image, then the matching point on the model. Use at least three points spread across the face.',
      'Alignment updates as you add or move points. Reapply alignment recalculates it from the saved pairs after other placement edits.',
    ],
  },
  mapping: {
    title: 'Mapping modes',
    lines: [
      { name: 'Front', detail: ' projects from the OBJ +Z side and stretches the image over the connected visible surface. Use Align to match landmarks.' },
      { name: 'Wrap', detail: ' follows the face and sides without model UVs; the back stays untextured. In Place image, left-drag to move and right-drag horizontally to rotate. Turn off Place image to orbit, then use Align.' },
      { name: 'Surface', detail: ' places one image on a visible side. Click or drag on the model to aim it.' },
      { name: 'Model UV', detail: ' uses the OBJ’s own UV layout and needs a matching texture atlas. For an ordinary image, choose Front.' },
    ],
  },
  mask: {
    title: 'Coverage mask',
    lines: [
      'Select Mask, click around the area, and double-click to finish its outline.',
      { name: 'Keep visible', detail: ' limits projection to the drawn region.' },
      { name: 'Exclude from projection', detail: ' cuts the region out of the output.' },
    ],
  },
  'projector-points': {
    title: 'Points on the model',
    lines: [
      'Start projection and select a numbered point. Drag its orange mark in the preview until the projected crosshair matches that point on the real surface.',
      'Recreate from Align replaces these points and the current correction with the image alignment points. Apply calculates the correction from at least three points.',
    ],
  },
  hold: {
    title: 'Hold projection',
    lines: [
      'Hold keeps the last projected frame on screen and mutes the sound. Release Hold to resume the live output.',
      'Freeze preview affects only the editor preview; the source and projection keep running.',
    ],
  },
};

export function createContextHelp() {
  const popup = document.querySelector('#help-popover');
  const title = popup.querySelector('#help-popover-title');
  const body = popup.querySelector('#help-popover-body');
  let active = null;

  function close({ restoreFocus = false } = {}) {
    if (!active) return;
    const previous = active;
    active = null;
    popup.hidden = true;
    previous.setAttribute('aria-expanded', 'false');
    if (restoreFocus && previous.isConnected) previous.focus();
  }

  function position() {
    if (!active) return;
    const anchor = active.getBoundingClientRect();
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    const gap = 8;
    const edge = 12;
    const left = Math.max(edge, Math.min(anchor.left + anchor.width / 2 - width / 2, innerWidth - width - edge));
    const below = anchor.bottom + gap;
    const top = below + height + edge <= innerHeight ? below : Math.max(edge, anchor.top - height - gap);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  function open(trigger) {
    const help = HELP[trigger.dataset.help];
    if (!help) return;
    close();
    active = trigger;
    title.textContent = help.title;
    body.replaceChildren(...help.lines.map(line => {
      const paragraph = document.createElement('p');
      if (typeof line === 'string') paragraph.textContent = line;
      else {
        const name = document.createElement('strong');
        name.textContent = line.name;
        paragraph.append(name, document.createTextNode(line.detail));
      }
      return paragraph;
    }));
    popup.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    position();
  }

  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('[data-help]');
    if (trigger) {
      if (active === trigger) close();
      else open(trigger);
    } else if (!popup.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) {
      event.preventDefault();
      close({ restoreFocus: true });
    }
  });
  document.addEventListener('scroll', () => close(), true);
  window.addEventListener('resize', position);
}
