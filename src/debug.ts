/**
 * Debug endpoint — returns raw AI response to see the actual format
 */
async function handleDebugAI(request: Request, env: Env): Promise<Response> {
  const { text = 'hello world' } = await request.json() as { text?: string };
  const response = await env.AI.run(env.EMBEDDING_MODEL, {
    text: [text.slice(0, 2000)],
  });
  return json({
    rawType: typeof response,
    keys: Object.keys(response || {}),
    shape: response?.shape,
    responseType: typeof response?.response,
    dataLength: response?.data?.length,
    responseLength: response?.response?.length,
    sample: JSON.stringify(response).slice(0, 500),
  });
}
