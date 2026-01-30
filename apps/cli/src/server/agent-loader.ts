import { printInfoMessages } from '@/utils/print-info-messages.js';
import { log } from '../utils/logger.js';
import configResolver from '@/config/index.js';
import { Agent } from '@stagewise/agent-client';
import { ClaudeCodeAgent } from '@stagewise/agent-claude-code';
import { ClientRuntimeNode } from '@stagewise/agent-runtime-node';
import { analyticsEvents } from '@/utils/telemetry.js';

let agentInstance: Agent | ClaudeCodeAgent | null = null;

/**
 * Loads and initializes the agent server
 */
export async function loadAndInitializeAgent(
  accessToken: string,
  refreshToken: string,
): Promise<{ success: boolean; wss?: unknown }> {
  try {
    const config = configResolver.getConfig();

    // Use Claude Code agent if specified
    if (config.agent === 'claude-code') {
      log.info('Using Claude Code agent');

      agentInstance = ClaudeCodeAgent.getInstance({
        command: config.claudeCommand ?? 'claude',
        cwd: config.dir,
        skipPermissions: true,
      });

      const agentServer = await agentInstance.initialize();

      return {
        success: true,
        wss: agentServer.wss,
      };
    }

    // Default agent
    if (!Agent || typeof Agent.getInstance !== 'function') {
      throw new Error('Agent class not found or invalid');
    }

    if (!ClientRuntimeNode || typeof ClientRuntimeNode !== 'function') {
      throw new Error('ClientRuntimeNode class not found or invalid');
    }

    // Create client runtime instance
    const clientRuntime = new ClientRuntimeNode({
      workingDirectory: config.dir,
    });

    // Create agent instance
    agentInstance = Agent.getInstance({
      clientRuntime,
      accessToken,
      refreshToken,
      onEvent: async (event) => {
        printInfoMessages(event);
        switch (event.type) {
          case 'agent_prompt_triggered':
            analyticsEvents.sendPrompt();
            break;
          case 'credits_insufficient':
            analyticsEvents.creditsInsufficient({
              status: event.data.subscription?.subscription?.status || '',
              credits: event.data.subscription?.credits?.total || 0,
              credits_used: event.data.subscription?.credits?.used || 0,
              credits_remaining:
                event.data.subscription?.credits?.available || 0,
            });
            break;
          case 'plan_limits_exceeded':
            analyticsEvents.planLimitsExceeded({
              status: event.data.subscription?.subscription?.status || '',
            });
            break;
          default:
            break;
        }
      },
    });

    // Initialize agent with Express integration
    // This will automatically set up the Karton endpoint
    const agentServer = await agentInstance.initialize();

    // Return the WebSocket server instance if available
    // The agent SDK may not return the WebSocket server in current versions
    return {
      success: true,
      wss: agentServer.wss,
    };
  } catch (error) {
    log.error(
      `Failed to initialize agent server: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
    if (error instanceof Error && error.stack) {
      log.debug(`Stack trace: ${error.stack}`);
    }
    return { success: false };
  }
}

export function shutdownAgent(): void {
  if (agentInstance?.shutdown) {
    try {
      agentInstance.shutdown();
      log.debug('Agent server shut down successfully');
    } catch (error) {
      log.error(
        `Error shutting down agent: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
  // Clear the instance reference
  agentInstance = null;
}

export function getAgentInstance(): any {
  return agentInstance;
}
