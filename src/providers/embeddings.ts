import { type FetchFunction, postJson } from "./http";
import { endpoint, type ModelProfile, requestHeaders } from "./profile";

/** Creates embeddings with the OpenAI-compatible `/embeddings` endpoint or the Gemini `batchEmbedContents` method. */
export async function embed(
  profile: ModelProfile,
  apiKey: string | undefined,
  model: string,
  inputs: readonly string[],
  signal: AbortSignal,
  fetchFunction: FetchFunction = fetch,
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  if (profile.provider === "gemini") {
    const name = model.replace(/^models\//, "");
    const response = await postJson(
      fetchFunction,
      profile.name,
      endpoint(profile.baseUrl, `models/${encodeURIComponent(name)}:batchEmbedContents`, profile.query),
      requestHeaders(profile, apiKey),
      { requests: inputs.map((text) => ({ model: `models/${name}`, content: { parts: [{ text }] } })) },
      signal,
    );
    const data = (await response.json()) as { embeddings?: { values?: number[] }[] };
    return (data.embeddings ?? []).map((item) => item.values ?? []);
  }
  if (profile.provider !== "openai") throw new Error("Embeddings need an OpenAI-compatible or Gemini model profile.");
  const response = await postJson(
    fetchFunction,
    profile.name,
    endpoint(profile.baseUrl, "embeddings", profile.query),
    requestHeaders(profile, apiKey),
    { model, input: inputs },
    signal,
  );
  const data = (await response.json()) as { data?: { index?: number; embedding?: number[] }[] };
  const result: number[][] = new Array(inputs.length).fill(undefined).map(() => []);
  (data.data ?? []).forEach((item, position) => {
    result[typeof item.index === "number" ? item.index : position] = item.embedding ?? [];
  });
  return result;
}
