// A single next action keeps the editor's stages visible without a persistent wizard.
export function nextWorkflowStep(snapshot, mode = 'placement') {
  const project = snapshot?.project;
  if (!project) return null;
  if (!project.mesh) return {
    id: 'model', title: 'Project an image onto a real object',
    detail: 'Load its 3D model, add an image or live video, fit it to the model, then calibrate the projector.',
    action: 'Choose 3D model',
  };
  if (snapshot.source?.kind === 'webrtc') {
    if (snapshot.source.status !== 'running') return {
      id: 'connect', title: 'Connect your live video',
      detail: 'Start receiving video, then send a picture from a browser or a WHIP app.', action: 'Set up video',
    };
  } else if (!snapshot.referencePreview) return {
    id: 'source', title: 'Choose content to project',
    detail: 'Add an image, or choose live video in the Source panel.', action: 'Choose image',
  };
  if (mode === 'projector') {
    if (!snapshot.displayId) return {
      id: 'display', title: 'Choose a screen for the projector',
      detail: 'The screen opens black. Choose it before adding calibration points.', action: 'Choose screen',
    };
    if ((project.projector.calibration?.pairs.length || 0) < 3) {
      const placement = project.placement;
      const align = placement.mappingMode === 'wrap' ? placement.wrap.alignment : placement.alignment;
      const hasAlignPoints = (align?.pairs.length || 0) > 0;
      return {
        id: 'physical-points', title: 'Match points on the real object',
        detail: 'Add at least three model points. Each selected point appears as a cross on the projected image.',
        action: hasAlignPoints ? 'Use Align points' : 'Add model point',
      };
    }
    if (!snapshot.output?.armed) return {
      id: 'projection', title: 'Ready to check the projection',
      detail: 'Start projection, move the orange marks to match the real object, then apply the correction.',
      action: 'Start projection',
    };
    return null;
  }
  const placement = project.placement;
  if (placement.mappingMode === 'front' || placement.mappingMode === 'wrap') {
    const mapping = placement.mappingMode === 'wrap' ? placement.wrap : placement;
    if ((mapping.alignment?.pairs.length || 0) < 3 || mapping.grid.columns <= 5) return {
      id: 'align', title: 'Fit the image to the 3D model',
      detail: 'Match at least three points on the image and model. The fit updates automatically.', action: 'Align points',
    };
  }
  if (!snapshot.displayId) return {
    id: 'display', title: 'Fit the projector to the real object',
    detail: 'Choose a screen, then adjust matching points while looking at the real surface.', action: 'Choose screen',
  };
  if (!snapshot.output?.armed) return {
    id: 'projection', title: 'Ready for projection',
    detail: 'Check the image on the real object, then start projection.', action: 'Start projection',
  };
  return null;
}
