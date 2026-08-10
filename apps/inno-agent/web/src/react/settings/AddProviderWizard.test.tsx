import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../i18n/index.js";
import { AddProviderWizard } from "./AddProviderWizard.js";

const { probeProviderModels } = vi.hoisted(() => ({
	probeProviderModels: vi.fn(),
}));

vi.mock("../../api/settings.js", () => ({ probeProviderModels }));
vi.mock("../../stores/settings-store.js", () => ({
	settingsStore: { saveProvider: vi.fn() },
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("AddProviderWizard model picker", () => {
	it("uses the saved brand assets for preset provider icons", () => {
		render(<AddProviderWizard providers={{}} />);
		fireEvent.click(screen.getByRole("button", { name: /新增提供方|New provider/ }));

		for (const icon of [
			"deepseek.ico",
			"kimi-rounded.png",
			"minimax-user-icon.png",
			"volcengine-icon.svg",
			"xiaomi-mi.png",
			"bailian.svg",
		]) {
			expect(document.querySelector(`img[src="/provider-icons/${icon}"]`)).toBeTruthy();
		}
	});

	it("shows every fetched model after expanding the simple list", async () => {
		probeProviderModels.mockResolvedValue({
			models: ["deepseek-v4-flash", "deepseek-v4-reasoner"],
		});

		render(<AddProviderWizard providers={{}} />);
		fireEvent.click(screen.getByRole("button", { name: /新增提供方|New provider/ }));
		fireEvent.click(screen.getByRole("button", { name: /DeepSeek/ }));
		fireEvent.click(screen.getByRole("button", { name: /拉取模型列表|Fetch model list/ }));

		await waitFor(() => expect(probeProviderModels).toHaveBeenCalledOnce());
		const input = screen.getByRole("combobox") as HTMLInputElement;
		await waitFor(() => expect(input.value).toBe("deepseek-v4-flash"));

		fireEvent.click(screen.getByRole("button", { name: "展开模型列表" }));

		expect(screen.getAllByRole("option")).toHaveLength(2);
		const initiallySelected = screen.getByRole("option", { name: "deepseek-v4-flash" });
		expect(initiallySelected.querySelector("svg")).toBeTruthy();
		expect(screen.getByRole("option", { name: "deepseek-v4-reasoner" }).querySelector("svg")).toBeNull();

		fireEvent.click(screen.getByRole("option", { name: "deepseek-v4-reasoner" }));
		expect(input.value).toBe("deepseek-v4-reasoner");
		fireEvent.click(screen.getByRole("button", { name: "展开模型列表" }));
		expect(screen.getByRole("option", { name: "deepseek-v4-reasoner" }).querySelector("svg")).toBeTruthy();
	});
});
