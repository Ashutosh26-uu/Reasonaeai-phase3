/**
 * @vitest-environment jsdom
 */

import type { SurfaceError } from "@reasonateai/contracts/intent";
import { MockVisionAdapter } from "@reasonateai/voice-gateway";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WireframeUpload } from "../../components/surfaces/wireframe-upload";

// Mock URL.createObjectURL and revokeObjectURL
const mockCreateObjectURL = vi.fn(() => "blob:http://localhost/mock-uuid");
const mockRevokeObjectURL = vi.fn();
Object.defineProperty(global.URL, "createObjectURL", {
  value: mockCreateObjectURL,
  writable: true,
});
Object.defineProperty(global.URL, "revokeObjectURL", {
  value: mockRevokeObjectURL,
  writable: true,
});

describe("WireframeUpload UI — Phase 6", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  const createFile = (name: string, type: string, size: number): File => {
    const file = new File(["a".repeat(size || 1)], name, { type });
    Object.defineProperty(file, "size", { value: size });
    return file;
  };

  // 16. Initial empty state
  it("16. initial empty state renders", () => {
    const { container } = render(<WireframeUpload />);
    expect(screen.getByText("Wireframe Upload")).toBeDefined();
    expect(container.textContent).toContain("empty");
    expect(screen.getByLabelText("File input")).toBeDefined();
    expect(screen.getByLabelText("Upload wireframe area")).toBeDefined();
  });

  // 17. Valid image selection
  it("17. valid PNG image is accepted and shown", async () => {
    const { container } = render(<WireframeUpload />);
    const fileInput = screen.getByLabelText("File input");

    const pngFile = createFile("wireframe.png", "image/png", 1024);
    fireEvent.change(fileInput, { target: { files: [pngFile] } });

    await waitFor(() => {
      expect(container.textContent).toContain("selected");
      expect(screen.getByText("wireframe.png")).toBeDefined();
      expect(mockCreateObjectURL).toHaveBeenCalledWith(pngFile);
    });
  });

  // 18. Unsupported file type
  it("18. unsupported file type is rejected with user message", async () => {
    const { container } = render(<WireframeUpload />);
    const fileInput = screen.getByLabelText("File input");

    const txtFile = createFile("sketch.pdf", "application/pdf", 1024);
    fireEvent.change(fileInput, { target: { files: [txtFile] } });

    await waitFor(() => {
      expect(container.textContent).toContain("unsupported");
      expect(
        screen.getByText("Please upload a PNG, JPEG, or WebP image.")
      ).toBeDefined();
    });
  });

  // 19. File too large
  it("19. file exceeding 5MB is rejected", async () => {
    const { container } = render(<WireframeUpload />);
    const fileInput = screen.getByLabelText("File input");

    const bigFile = createFile("huge.png", "image/png", 5 * 1024 * 1024 + 1);
    fireEvent.change(fileInput, { target: { files: [bigFile] } });

    await waitFor(() => {
      expect(container.textContent).toContain("unsupported");
      expect(
        screen.getByText("File size must be less than 5MB.")
      ).toBeDefined();
    });
  });

  // 20. Processing state
  it("20. shows processing state during vision adapter call", async () => {
    const slowAdapter = {
      processImage: () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                components: [],
                inferredFeatures: [],
                screens: [],
                workflow: "",
              }),
            100
          );
        }),
    };

    const { container } = render(
      <WireframeUpload visionAdapter={slowAdapter as MockVisionAdapter} />
    );
    const fileInput = screen.getByLabelText("File input");

    const pngFile = createFile("test.png", "image/png", 1024);
    fireEvent.change(fileInput, { target: { files: [pngFile] } });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Process wireframe" })
      ).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Process wireframe" }));

    // Should be in processing state
    await waitFor(() => {
      expect(container.textContent).toContain("processing");
      expect(screen.getByTestId("processing-icon")).toBeDefined();
    });
  });

  // 21. VisionAdapter receives File
  it("21. visionAdapter.processImage receives the selected file", async () => {
    const mockAdapter = new MockVisionAdapter();
    const spy = vi.spyOn(mockAdapter, "processImage");

    render(<WireframeUpload visionAdapter={mockAdapter} />);
    const fileInput = screen.getByLabelText("File input");

    const pngFile = createFile("test.png", "image/png", 1024);
    fireEvent.change(fileInput, { target: { files: [pngFile] } });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Process wireframe" })
      ).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Process wireframe" }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(pngFile);
    });
  });

  // 22. StructuredIntent rendered
  it("22. structured intent is rendered after processing", async () => {
    const mockAdapter = new MockVisionAdapter();

    const { container } = render(
      <WireframeUpload visionAdapter={mockAdapter} />
    );
    const fileInput = screen.getByLabelText("File input");

    const pngFile = createFile("test.png", "image/png", 1024);
    fireEvent.change(fileInput, { target: { files: [pngFile] } });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Process wireframe" })
      ).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Process wireframe" }));

    await waitFor(() => {
      expect(container.textContent).toContain("completed");
      expect(screen.getByText("Dashboard (Mock)")).toBeDefined();
      expect(screen.getByText("Data Table (Mock)")).toBeDefined();
    });
  });

  // 23. Empty structured intent
  it("23. empty structured intent renders without crashing", async () => {
    const emptyAdapter = {
      processImage: vi.fn().mockResolvedValue({
        components: [],
        inferredFeatures: [],
        screens: [],
        workflow: "",
      }),
    };

    const { container } = render(
      <WireframeUpload
        visionAdapter={emptyAdapter as unknown as MockVisionAdapter}
      />
    );
    const fileInput = screen.getByLabelText("File input");

    const pngFile = createFile("test.png", "image/png", 1024);
    fireEvent.change(fileInput, { target: { files: [pngFile] } });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Process wireframe" })
      ).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Process wireframe" }));

    await waitFor(() => {
      expect(container.textContent).toContain("completed");
      expect(screen.getByText("No screens identified.")).toBeDefined();
      expect(screen.getByText("No components identified.")).toBeDefined();
    });
  });

  // 24. VisionAdapter failure
  it("24. adapter failure produces user-friendly error", async () => {
    const errorAdapter = {
      processImage: async (): Promise<SurfaceError> => ({
        code: "SIMULATED_ERROR",
        message: "Simulated backend error",
        userMessage: "We could not process the image right now.",
      }),
    };

    const { container } = render(
      <WireframeUpload visionAdapter={errorAdapter} />
    );
    const fileInput = screen.getByLabelText("File input");

    const pngFile = createFile("test.png", "image/png", 1024);
    fireEvent.change(fileInput, { target: { files: [pngFile] } });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Process wireframe" })
      ).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Process wireframe" }));

    await waitFor(() => {
      expect(container.textContent).toContain("failed");
      expect(
        screen.getByText("We could not process the image right now.")
      ).toBeDefined();
    });
  });

  // 25. Retry / Upload Another
  it("25. upload another from completed state resets UI", async () => {
    const mockAdapter = new MockVisionAdapter();

    const { container } = render(
      <WireframeUpload visionAdapter={mockAdapter} />
    );
    const fileInput = screen.getByLabelText("File input");

    const pngFile = createFile("test.png", "image/png", 1024);
    fireEvent.change(fileInput, { target: { files: [pngFile] } });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Process wireframe" })
      ).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Process wireframe" }));

    await waitFor(() => {
      expect(container.textContent).toContain("completed");
    });

    const uploadAnother = screen.getByRole("button", {
      name: "Upload another",
    });
    fireEvent.click(uploadAnother);

    await waitFor(() => {
      expect(container.textContent).toContain("empty");
      expect(mockRevokeObjectURL).toHaveBeenCalled();
    });
  });

  // 26. Accept & Continue callback
  it("26. accept & continue invokes onComplete with intent", async () => {
    const mockAdapter = new MockVisionAdapter();
    const onComplete = vi.fn();

    render(
      <WireframeUpload onComplete={onComplete} visionAdapter={mockAdapter} />
    );
    const fileInput = screen.getByLabelText("File input");

    const pngFile = createFile("test.png", "image/png", 1024);
    fireEvent.change(fileInput, { target: { files: [pngFile] } });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Process wireframe" })
      ).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Process wireframe" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Continue with intent" })
      ).toBeDefined();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with intent" })
    );

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        components: ["Data Table (Mock)", "Sidebar (Mock)"],
        screens: ["Dashboard (Mock)"],
      })
    );
  });

  // 27. Duplicate submission protection
  it("27. process wireframe button hidden during processing", async () => {
    const mockAdapter = new MockVisionAdapter();
    const spy = vi.spyOn(mockAdapter, "processImage");

    render(<WireframeUpload visionAdapter={mockAdapter} />);
    const fileInput = screen.getByLabelText("File input");

    const pngFile = createFile("test.png", "image/png", 1024);
    fireEvent.change(fileInput, { target: { files: [pngFile] } });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Process wireframe" })
      ).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Process wireframe" }));

    // Process button should be gone during processing
    expect(
      screen.queryByRole("button", { name: "Process wireframe" })
    ).toBeNull();

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // 28. Preview cleanup: object URL revoked on file removal
  it("28. object URL is revoked when file is removed", async () => {
    render(<WireframeUpload />);
    const fileInput = screen.getByLabelText("File input");

    const pngFile = createFile("test.png", "image/png", 1024);
    fireEvent.change(fileInput, { target: { files: [pngFile] } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Remove file" })).toBeDefined();
    });

    mockRevokeObjectURL.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Remove file" }));

    await waitFor(() => {
      expect(mockRevokeObjectURL).toHaveBeenCalled();
    });
  });

  // Additional: empty file is rejected
  it("empty file (0 bytes) is rejected", async () => {
    render(<WireframeUpload />);
    const fileInput = screen.getByLabelText("File input");

    const emptyFile = createFile("empty.png", "image/png", 0);
    fireEvent.change(fileInput, { target: { files: [emptyFile] } });

    await waitFor(() => {
      expect(screen.getByText("The selected file is empty.")).toBeDefined();
    });
  });

  // Additional: failed state shows upload area for retry
  it("failed state shows upload area for retry", async () => {
    const errorAdapter = {
      processImage: vi.fn().mockRejectedValue(new Error("Processing failed")),
    };

    const { container } = render(
      <WireframeUpload
        visionAdapter={errorAdapter as unknown as MockVisionAdapter}
      />
    );
    const fileInput = screen.getByLabelText("File input");

    const pngFile = createFile("test.png", "image/png", 1024);
    fireEvent.change(fileInput, { target: { files: [pngFile] } });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Process wireframe" })
      ).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Process wireframe" }));

    await waitFor(() => {
      expect(container.textContent).toContain("failed");
    });

    // Upload area should reappear for retry
    expect(screen.getByLabelText("Upload wireframe area")).toBeDefined();
  });
});
