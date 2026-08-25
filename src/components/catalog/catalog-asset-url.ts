export function catalogThumbnailUrl(imageUrl: string) {
  return `${imageUrl}${imageUrl.includes("?") ? "&" : "?"}variant=thumbnail`;
}
