/** Add missing RFC 5576 metadata to RTX SSRCs in WHIP video offers. */
export function normalizeWhipSdp(sdp, maxLength = 256 * 1024) {
  if (typeof sdp !== 'string') throw new TypeError('WHIP SDP must be a string');
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new TypeError('WHIP SDP limit must be a positive integer');
  if (Buffer.byteLength(sdp, 'utf8') > maxLength) throw new RangeError('WHIP SDP exceeds its size limit');
  const lineEnding = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^m=/i.test(lines[index])) starts.push(index);
  }
  if (!starts.length) return sdp;

  let changed = false;
  let normalizedLength = Buffer.byteLength(sdp, 'utf8');
  const additionsByIndex = new Map();
  for (let sectionIndex = 0; sectionIndex < starts.length; sectionIndex += 1) {
    const start = starts[sectionIndex];
    const end = starts[sectionIndex + 1] ?? lines.length;
    if (!/^m=video(?:\s|$)/i.test(lines[start])) continue;
    const section = lines.slice(start, end);
    const attributesBySsrc = new Map();
    const groups = [];
    for (const line of section) {
      const attribute = /^a=ssrc:(\d+)\s+(cname|msid):(.+)$/i.exec(line);
      if (attribute) {
        const [, ssrc, kind, value] = attribute;
        const attributes = attributesBySsrc.get(ssrc) ?? new Map();
        const values = attributes.get(kind.toLowerCase()) ?? [];
        values.push(value);
        attributes.set(kind.toLowerCase(), values);
        attributesBySsrc.set(ssrc, attributes);
        continue;
      }
      const group = /^a=ssrc-group:FID\s+(\d+)\s+(\d+)\s*$/.exec(line);
      if (group) groups.push({ primary: group[1], repair: group[2] });
    }

    const additions = [];
    for (const { primary, repair } of groups) {
      const primaryAttributes = attributesBySsrc.get(primary);
      if (!primaryAttributes) continue;
      const repairAttributes = attributesBySsrc.get(repair) ?? new Map();
      for (const kind of ['cname', 'msid']) {
        if (repairAttributes.has(kind)) continue;
        const values = [...new Set(primaryAttributes.get(kind) ?? [])];
        if (values.length !== 1) continue;
        const line = `a=ssrc:${repair} ${kind}:${values[0]}`;
        const nextLength = normalizedLength + Buffer.byteLength(lineEnding, 'utf8') + Buffer.byteLength(line, 'utf8');
        if (nextLength > maxLength) throw new RangeError('Normalized WHIP SDP exceeds its size limit');
        normalizedLength = nextLength;
        additions.push(line);
        repairAttributes.set(kind, values);
        attributesBySsrc.set(repair, repairAttributes);
      }
    }
    if (additions.length) {
      changed = true;
      const insertionIndex = end === lines.length && lines.at(-1) === '' ? end - 1 : end;
      additionsByIndex.set(insertionIndex, additions);
    }
  }
  if (!changed) return sdp;

  const result = [];
  for (let index = 0; index <= lines.length; index += 1) {
    const additions = additionsByIndex.get(index);
    if (additions) result.push(...additions);
    if (index < lines.length) result.push(lines[index]);
  }
  return result.join(lineEnding);
}
