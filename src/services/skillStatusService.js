"use strict";

function hasWorkspaceSkills(status) {
    const workspace = status?.scopes?.workspace;
    return !!workspace && workspace.state !== "notInstalled";
}

class SkillStatusService {
    constructor(options) {
        this.vscode = options.vscode;
        this.context = options.context;
        this.installer = options.installer;
        this.getLang = options.getLang;
        this.t = options.t;
        this.onStatus = options.onStatus;
        this.lastStatus = null;
        this.bridgeWarned = false;
        this.upgradePrompted = false;
    }

    post(status) {
        this.onStatus(status);
    }

    async refresh() {
        const status = await this.installer.inspectSkills(this.vscode, this.context);
        this.lastStatus = status;
        this.post(status);
        this.promptUpgrade(status);
        return status;
    }

    warnIfModified() {
        if (this.bridgeWarned || this.lastStatus?.state !== "modified") return;
        this.bridgeWarned = true;
        const manage = this.t("msg.skillsManage");
        this.vscode.window.showWarningMessage(this.t("msg.skillsModifiedBridgeWarn"), manage).then((choice) => {
            if (choice === manage) this.vscode.commands.executeCommand("mcu-vscode.manageAgentSkills");
        });
    }

    promptUpgrade(status) {
        if (this.upgradePrompted || !["outdated", "modified", "partial"].includes(status.state)) return;
        this.upgradePrompted = true;
        const manage = this.t("msg.skillsManage");
        this.vscode.window.showInformationMessage(this.t("msg.skillsDiffers"), manage).then((choice) => {
            if (choice === manage) this.vscode.commands.executeCommand("mcu-vscode.manageAgentSkills");
        });
    }

    scopeStateText(scope) {
        if (!scope) return this.t("skill.noWorkspace");
        const hasCount = Number.isFinite(scope.installed) && Number.isFinite(scope.total) && scope.total > 0;
        if (scope.state === "installed" && hasCount) {
            return this.t("skill.installed", { installed: scope.installed, total: scope.total });
        }
        if (scope.state === "partial" && hasCount) {
            return this.t("skill.partial", { installed: scope.installed, total: scope.total });
        }
        const key = {
            outdated: "skill.outdated",
            modified: "skill.modified",
            notInstalled: "skill.notInstalled"
        }[scope.state];
        return this.t(key || "skill.notInstalled");
    }

    scopeHasContent(scope) {
        return !!scope && scope.state !== "notInstalled";
    }

    async manage() {
        const status = await this.installer.inspectSkills(this.vscode, this.context);
        const hasWorkspace = !!this.vscode.workspace.workspaceFolders?.[0];
        const items = [];
        if (hasWorkspace) {
            items.push({
                id: "install:workspace",
                label: `$(folder) ${this.t("skill.menuInstallWorkspace")}`,
                description: this.scopeStateText(status.scopes.workspace),
                detail: status.scopes.workspace.root
            });
        }
        items.push({
            id: "install:global",
            label: `$(home) ${this.t("skill.menuInstallGlobal")}`,
            description: this.scopeStateText(status.scopes.global),
            detail: status.scopes.global.root
        });
        if (this.scopeHasContent(status.scopes.workspace) || this.scopeHasContent(status.scopes.global)) {
            items.push({ id: "uninstall", label: `$(trash) ${this.t("skill.menuUninstall")}` });
        }
        const pick = await this.vscode.window.showQuickPick(items, {
            placeHolder: this.t("skill.menuPlaceholder")
        });
        if (!pick) return false;
        let result;
        if (pick.id === "uninstall") {
            const scope = await this.pickUninstallScope(status, hasWorkspace);
            if (!scope) return false;
            result = await this.installer.uninstallSkill(this.vscode, this.context, this.getLang(), scope);
        } else {
            result = await this.installer.installSkill(
                this.vscode,
                this.context,
                this.getLang(),
                pick.id.split(":")[1]
            );
        }
        this.post(result);
        return result;
    }

    async pickUninstallScope(status, hasWorkspace) {
        const items = [];
        if (hasWorkspace && this.scopeHasContent(status.scopes.workspace)) {
            items.push({
                id: "workspace",
                label: `$(trash) ${this.t("skill.menuUninstallWorkspace")}`,
                detail: status.scopes.workspace.root
            });
        }
        if (this.scopeHasContent(status.scopes.global)) {
            items.push({
                id: "global",
                label: `$(trash) ${this.t("skill.menuUninstallGlobal")}`,
                detail: status.scopes.global.root
            });
        }
        if (!items.length) return null;
        const pick = await this.vscode.window.showQuickPick(items, {
            placeHolder: this.t("skill.uninstallPlaceholder")
        });
        if (!pick) return null;
        const root = pick.id === "global" ? status.scopes.global.root : status.scopes.workspace.root;
        const confirmButton = this.t("skill.uninstallConfirm");
        const confirm = await this.vscode.window.showWarningMessage(
            this.t("skill.confirmUninstall", { path: root }),
            { modal: true },
            confirmButton
        );
        return confirm === confirmButton ? pick.id : null;
    }
}

module.exports = { SkillStatusService, hasWorkspaceSkills };
