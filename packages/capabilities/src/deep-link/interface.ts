export type DeepLinkHandler = (url: string) => void;

export interface DeepLink {
  onOpen(handler: DeepLinkHandler): () => void;
}
