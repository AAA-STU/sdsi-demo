import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';

/**
 * MasterX activation: register the sidebar webview and the four commands.
 */
export function activate(context: vscode.ExtensionContext): void {
  const version = context.extension.packageJSON?.version ?? '0.0.0';
  const provider = new ChatViewProvider(context.extensionUri, version);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('masterx.execute', () => {
      provider.focus();
      void provider.executeFromCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('masterx.focus', () => {
      provider.focus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('masterx.reset', () => {
      provider.reset();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('masterx.showConfig', () => {
      void provider.showConfig();
    })
  );
}

/** Nothing to tear down: everything is disposed via context.subscriptions. */
export function deactivate(): void {
  // Intentionally empty.
}
