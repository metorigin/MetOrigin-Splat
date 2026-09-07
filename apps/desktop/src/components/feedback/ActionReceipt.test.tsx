import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ActionReceipt as ActionReceiptModel } from "../../types";
import { ActionReceipt } from "./ActionReceipt";

describe("ActionReceipt", () => {
  it("redacts credentials and private paths at the rendering boundary", () => {
    const receipt: ActionReceiptModel = {
      id: "receipt-safe",
      action: "cancel",
      status: "success",
      title: "操作完成",
      message:
        "token=METORIGIN_TEST_SECRET_DO_NOT_EXPOSE C:\\Users\\PrivateUser\\project",
      completedAt: "2026-08-14T00:00:00Z",
      affectedResources: ["pipeline"],
      dismissible: false,
    };

    render(<ActionReceipt receipt={receipt} />);
    const status = screen.getByRole("status");
    expect(status).not.toHaveTextContent("METORIGIN_TEST_SECRET_DO_NOT_EXPOSE");
    expect(status).not.toHaveTextContent("PrivateUser");
    expect(status).toHaveTextContent("[REDACTED]");
    expect(status).toHaveTextContent("[REDACTED_PATH]");
  });
});
