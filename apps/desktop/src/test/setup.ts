import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { setLanguagePreference } from "../i18n";

// Existing behavior tests use Chinese, independently of the host OS language.
beforeEach(() => setLanguagePreference("zh-CN"));

afterEach(() => cleanup());
