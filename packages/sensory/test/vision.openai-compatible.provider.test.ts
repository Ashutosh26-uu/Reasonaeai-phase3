import { describe, expect, it, vi } from "vitest";

import { createOpenAICompatibleVisionProvider } from "../src/vision/vision.openai-compatible.provider.js";

const HTTP_503_REGEX = /503/;

describe("OpenAI-compatible Vision provider", () => {
  it("sends the image to the configured multimodal model and parses the result", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    elements: [
                      {
                        description: "A submit button",
                        text: "Submit",
                        type: "button",
                      },
                    ],
                    summary: "A form containing a submit button.",
                  }),
                },
              },
            ],
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 200,
          }
        )
    );

    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatibleVisionProvider({
      baseUrl: "http://vision.test/v1",
      model: "Qwen3-VL-30B-A3B-Instruct",
    });

    const result = await provider.extract({
      image: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      prompt: "Extract the editable UI structure.",
    });

    expect(result).toEqual({
      elements: [
        {
          description: "A submit button",
          text: "Submit",
          type: "button",
        },
      ],
      summary: "A form containing a submit button.",
    });

    // Verify the provider uses the configured model and sends the image
    // as a standard data URL. The provider remains model-agnostic even
    // though our current deployment target is Qwen3-VL.
    expect(fetchMock).toHaveBeenCalledOnce();

    const [firstCall] = fetchMock.mock.calls;

    // TypeScript correctly treats a mock call as potentially absent.
    // Narrow it explicitly before destructuring the request arguments.
    expect(firstCall).toBeDefined();

    if (!firstCall) {
      throw new Error("Expected Vision provider to call fetch");
    }

    const [, request] = firstCall;

    expect(request).toBeDefined();

    if (!request) {
      throw new Error("Expected Vision provider to provide fetch options");
    }

    const body = JSON.parse(String(request.body)) as {
      model: string;
      messages: Array<{
        content: Array<{
          type: string;
          image_url?: {
            url: string;
          };
        }>;
      }>;
    };

    expect(body.model).toBe("Qwen3-VL-30B-A3B-Instruct");

    const imagePart = body.messages[0]?.content.find(
      (part) => part.type === "image_url"
    );

    expect(imagePart?.image_url?.url).toBe("data:image/png;base64,AQID");
  });

  it("rejects malformed VisionOutput", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    invalid: true,
                  }),
                },
              },
            ],
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 200,
          }
        )
    );

    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatibleVisionProvider({
      baseUrl: "http://vision.test/v1",
      model: "Qwen3-VL-30B-A3B-Instruct",
    });

    // Provider output is validated at the adapter boundary so malformed
    // model responses cannot leak into the rest of the application.
    await expect(
      provider.extract({
        image: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
        prompt: "Extract the editable UI structure.",
      })
    ).rejects.toThrow();
  });

  it("propagates HTTP failures from the Vision endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response("vision service unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        })
    );

    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAICompatibleVisionProvider({
      baseUrl: "http://vision.test/v1",
      model: "Qwen3-VL-30B-A3B-Instruct",
    });

    // HTTP failures must remain visible to the gateway so its error
    // boundary can classify the operation as a Vision failure.
    await expect(
      provider.extract({
        image: new Uint8Array([1, 2, 3]),
        mimeType: "image/png",
        prompt: "Extract the editable UI structure.",
      })
    ).rejects.toThrow(HTTP_503_REGEX);
  });
});
