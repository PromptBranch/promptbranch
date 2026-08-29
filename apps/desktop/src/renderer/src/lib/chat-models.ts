/**
 * Ordering tier for connection-test model candidates. Suggests, never
 * decides: 0 = confirmed chat-capable (text in, text out), 1 = no modality
 * data (sparse catalogs), 2 = known non-text (image/music/video). Shared by
 * the connect dialog and the providers-list re-test dialog so both list
 * models in the same order.
 */
export function chatModelTier(model: {
  inputModalities: string[];
  outputModalities: string[];
}): number {
  const inputNonText = model.inputModalities.length > 0 && !model.inputModalities.includes("text");
  const outputNonText = model.outputModalities.length > 0 && !model.outputModalities.includes("text");
  if (inputNonText || outputNonText) return 2;
  return model.inputModalities.includes("text") && model.outputModalities.includes("text") ? 0 : 1;
}
