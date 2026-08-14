export function cropRect(width, height, aspect, focalX = 0.5, focalY = 0.5, zoom = 1) {
  const sourceAspect = width / height;
  const targetAspect = aspect || sourceAspect;
  const safeZoom = Math.min(4, Math.max(1, Number(zoom) || 1));
  const fittedWidth = sourceAspect > targetAspect ? height * targetAspect : width;
  const fittedHeight = sourceAspect > targetAspect ? height : width / targetAspect;
  const cropWidth = fittedWidth / safeZoom;
  const cropHeight = fittedHeight / safeZoom;
  return {
    left: Math.min(Math.max(0, focalX * width - cropWidth / 2), width - cropWidth),
    top: Math.min(Math.max(0, focalY * height - cropHeight / 2), height - cropHeight),
    width: cropWidth,
    height: cropHeight
  };
}

export function panCrop(crop, sourceWidth, sourceHeight, deltaX, deltaY, displayWidth, displayHeight) {
  const rect = cropRect(sourceWidth, sourceHeight, crop.aspect, crop.focalX, crop.focalY, crop.zoom);
  const left = Math.min(Math.max(0, rect.left - deltaX / displayWidth * rect.width), sourceWidth - rect.width);
  const top = Math.min(Math.max(0, rect.top - deltaY / displayHeight * rect.height), sourceHeight - rect.height);
  return {
    focalX: (left + rect.width / 2) / sourceWidth,
    focalY: (top + rect.height / 2) / sourceHeight
  };
}
