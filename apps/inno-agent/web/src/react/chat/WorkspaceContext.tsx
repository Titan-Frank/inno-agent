import type { WorkspaceMeta } from "../../api/workspaces.js";
import type { SmartInputSettings } from "../../types/settings.js";
import { WorkspaceSwitcher, type WorkspaceChoice, type WorkspaceSelectionKind } from "../WorkspaceSwitcher.js";
import { SmartInputControl } from "./SmartInputControl.js";

interface WorkspaceContextProps {
	workspaces: WorkspaceMeta[];
	selectedWorkspaceId: string | null;
	selectedKind: WorkspaceSelectionKind;
	newWorkspaceName?: string;
	busy?: boolean;
	disabled?: boolean;
	onChange: (choice: WorkspaceChoice) => void;
	/** Import a workspace from a .zip archive picked via the menu action. */
	onImport?: (file: File) => void;
	smartInputSettings?: SmartInputSettings;
	onToggleSmartInput: () => void;
	onToggleSmartInputRule: (ruleId: string) => void;
	smartInputSaving?: boolean;
	onOpenSmartInputSettings: () => void;
}

/** Workspace context row used below the welcome composer. */
export function WorkspaceContext({
	workspaces,
	selectedWorkspaceId,
	selectedKind,
	newWorkspaceName = "",
	busy = false,
	disabled = false,
	onChange,
	onImport,
	smartInputSettings,
	onToggleSmartInput,
	onToggleSmartInputRule,
	smartInputSaving = false,
	onOpenSmartInputSettings,
}: WorkspaceContextProps) {
	return (
		<div className="inno-workspace-context-row">
			<WorkspaceSwitcher
				workspaces={workspaces}
				selectedWorkspaceId={selectedWorkspaceId}
				selectedKind={selectedKind}
				newWorkspaceName={newWorkspaceName}
				busy={busy}
				disabled={disabled}
				onChange={onChange}
				onImport={onImport}
			/>
			<SmartInputControl
				smartInputSettings={smartInputSettings}
				onToggleSmartInput={onToggleSmartInput}
				onToggleSmartInputRule={onToggleSmartInputRule}
				smartInputSaving={smartInputSaving}
				onOpenSmartInputSettings={onOpenSmartInputSettings}
			/>
		</div>
	);
}
