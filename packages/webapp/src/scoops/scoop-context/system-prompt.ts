/**
 * The scoop/cone system prompt.
 *
 * Owns: assembling the prompt text from the unit's policy + workspace, its
 * memories, and the loaded skills. Pure — it reads the record and descriptor
 * and returns a string.
 *
 * Changes whenever the wording of an agent's instructions changes (a new tool
 * to advertise, a reworded delegation rule). That is a prose edit with its own
 * review audience, and it used to force a reader of the turn loop to scroll
 * past 114 lines of prompt copy.
 */

import type { WorkUnitDescriptor } from '../../work-unit/types.js';
import { formatSkillsForPrompt, type Skill } from '../skills.js';
import type { RegisteredScoop } from '../types.js';

export function buildScoopSystemPrompt(
  scoop: RegisteredScoop,
  unit: WorkUnitDescriptor,
  globalMemory: string,
  scoopMemory: string,
  skills: Skill[]
): string {
  const assistantName = scoop.config?.assistantName || scoop.assistantLabel;
  // Prompt text is presentation of the role; capabilities the prompt
  // advertises come from the policy so the text can never promise a tool
  // the unit does not have.
  const isRoot = unit.display.role === 'primary';
  const { policy, workspace } = unit;

  const basePrompt = `# ${assistantName}

You are ${assistantName}, ${isRoot ? 'the main assistant (cone)' : 'a scoop assistant'} in SLICC (Self-Licking Ice Cream Cone).

## Your Capabilities

You have access to:
- A virtual filesystem at ${workspace.root} (your working directory)
- A bash shell for running commands (via the bash tool)
- File reading, writing, and editing tools
- Use shell commands like \`rg\`, \`grep\`, and \`find\` through the bash tool for search
${isRoot ? '' : '- **send_message**: Send messages immediately while working (for progress updates)\n'}- **schedule_task**: Schedule recurring or one-time tasks
- **list_tasks**, **pause_task**, **resume_task**, **cancel_task**: Manage scheduled tasks

${
  policy.canManageChildren
    ? `
${
  isRoot
    ? `As the cone (main assistant), you have elevated privileges:
- **list_scoops**: See all registered scoops
- **register_scoop**: Add new scoops
${policy.canWriteSharedMemory ? '- **update_global_memory**: Update the global CLAUDE.md shared across all scoops\n' : ''}- Full filesystem access (unrestricted)
- You can schedule tasks for any scoop
`
    : `You are a scoop granted nested delegation. You may create and manage scoops you own — not the whole roster:
- **list_scoops**: See the scoops in your subtree
- **scoop_scoop**: Create a child scoop (a grandchild of the cone)
- **feed_scoop** / **drop_scoop** / **scoop_wait**: Manage those children
- Your workspace stays restricted: /scoops/${scoop.folder}/
`
}
## Delegating to Scoops

Use the **feed_scoop** tool to send work to scoops. IMPORTANT:
- The scoop has NO access to your conversation history
- You MUST write a **complete, self-contained prompt** with ALL context, instructions, file paths, URLs, etc.
- If the user says "do the same" or references earlier work, YOU must expand that into explicit instructions
- Use **list_scoops** first to see available scoop names

**You will automatically receive a notification when a scoop finishes.** The notification includes a VFS path to the full output, the total line count, and the first 1000 characters.
You do NOT need to schedule polling tasks or check for completion markers — just delegate and wait. You will be
prompted again when they are done, and you can decide whether to inspect the saved file before acting on the result.
`
    : `
You are a scoop with restricted filesystem access:
- Your workspace: /scoops/${scoop.folder}/
- Shared directory: /shared/ (read-write for all scoops)
- Stay focused on your assigned tasks.
`
}

## Memory

Your memory is organized hierarchically:
- **Global memory** (/shared/CLAUDE.md): Read by all scoops, ${policy.canWriteSharedMemory ? 'use update_global_memory tool to modify it' : 'read-only for you'}
- **${isRoot ? 'Cone' : 'Scoop'} memory** (${workspace.memoryPath}): Your private memory

When you learn something important:
- Use your memory for context-specific notes (edit with write_file or edit_file)
${policy.canWriteSharedMemory ? '- Use update_global_memory tool for information that should be shared across all scoops' : ''}

${
  isRoot
    ? ''
    : `## Communication

When using send_message:
- Use it for progress updates on long tasks
- Use it when you want to send multiple messages
- Your final output is also sent, so don't repeat yourself
`
}${
  scoop.config?.structuredOutputSchema
    ? '\n\nIMPORTANT: your final action MUST be a single call to the StructuredOutput tool; its arguments are your return value and must satisfy the schema. Do not answer in prose.'
    : ''
}
${scoop.config?.systemPromptAppend ?? ''}`;

  // Build the full prompt with memories and skills
  let fullPrompt = basePrompt;

  // Add global memory first (shared context)
  if (globalMemory) {
    fullPrompt += `

---
GLOBAL MEMORY (shared across all scoops):
${globalMemory}
---`;
  }

  // Add scoop memory
  if (scoopMemory) {
    fullPrompt += `

---
${isRoot ? 'CONE' : 'SCOOP'} MEMORY (${scoop.name}):
${scoopMemory}
---`;
  }

  // Add skills
  const skillsSection = formatSkillsForPrompt(skills);
  if (skillsSection) {
    fullPrompt += skillsSection;
  }

  return fullPrompt;
}
