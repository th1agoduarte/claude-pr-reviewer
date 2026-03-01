/**
 * Instala e executa o Claude Code CLI no modo headless.
 * Suporta autenticação via OAuth token (subscription) ou API key.
 */

import * as tl from 'azure-pipelines-task-lib/task';
import { execSync } from 'child_process';

export interface ClaudeCodeOptions {
  authMethod: 'subscription' | 'apikey';
  oauthToken?: string;
  apiKey?: string;
  model: string;
  maxTurns: number;
}

export interface FileReviewIssue {
  severity: 'critical' | 'important' | 'suggestion';
  line?: number;
  description: string;
}

export interface FileReview {
  file: string;
  summary: string;
  issues: FileReviewIssue[];
  positives: string;
  hasFeedback: boolean;
  meetsSpecification?: boolean;
  specificationNotes?: string;
}

/**
 * Instala o Claude Code CLI globalmente via npm.
 */
export function installClaudeCode(): void {
  console.log('📦 Instalando Claude Code CLI...');

  try {
    // Verifica se já está instalado
    const version = execSync('claude --version 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    console.log(`Claude Code já instalado: ${version}`);
    return;
  } catch {
    // Não instalado, prossegue
  }

  try {
    execSync('npm install -g @anthropic-ai/claude-code@latest', {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: 'pipe',
    });
    console.log('✅ Claude Code CLI instalado com sucesso.');
  } catch (err: any) {
    throw new Error(
      `Falha ao instalar Claude Code CLI: ${err.message}. ` +
        `Certifique-se de que Node.js 20+ está disponível no agent.`
    );
  }
}

/**
 * Monta as variáveis de ambiente para autenticação do Claude Code.
 */
function buildAuthEnv(options: ClaudeCodeOptions): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as any;

  // Remove ambas para evitar conflito
  delete env['ANTHROPIC_API_KEY'];
  delete env['CLAUDE_CODE_OAUTH_TOKEN'];

  if (options.authMethod === 'subscription') {
    if (!options.oauthToken) {
      throw new Error(
        'OAuth Token não fornecido. Gere um com `claude setup-token` e configure como variável secreta.'
      );
    }
    env['CLAUDE_CODE_OAUTH_TOKEN'] = options.oauthToken;
    console.log('🔑 Autenticação: Subscription (OAuth Token)');
  } else {
    if (!options.apiKey) {
      throw new Error('API Key não fornecida.');
    }
    env['ANTHROPIC_API_KEY'] = options.apiKey;
    console.log('🔑 Autenticação: API Key');
  }

  return env;
}

/**
 * Executa o Claude Code CLI em modo headless com o diff fornecido.
 */
export function runReview(
  diff: string,
  systemPrompt: string,
  customPrompt: string,
  options: ClaudeCodeOptions
): string {
  const env = buildAuthEnv(options);

  // Monta o prompt completo
  let userPrompt = `Analise as seguintes mudanças de código desta Pull Request:\n\n${diff}`;
  if (customPrompt) {
    userPrompt += `\n\nInstruções adicionais do time:\n${customPrompt}`;
  }

  // Escreve o prompt em um arquivo temporário para evitar limites de argumento
  const tmpFile = '/tmp/claude_pr_prompt.txt';
  const fs = require('fs');
  fs.writeFileSync(tmpFile, userPrompt, 'utf-8');

  // Monta o comando
  const args = [
    '-p', systemPrompt,
    '--output-format', 'text',
    '--max-turns', String(options.maxTurns),
    '--model', options.model,
    '--dangerously-skip-permissions',
  ];

  const cmd = `cat ${tmpFile} | claude ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`;

  console.log(`🤖 Executando review com modelo ${options.model}...`);
  tl.debug(`Comando: ${cmd}`);

  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 300_000, // 5 min timeout
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env,
      shell: '/bin/bash',
    });

    // Limpa arquivo temporário
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    if (!output || output.trim().length === 0) {
      throw new Error('Claude Code retornou resposta vazia.');
    }

    console.log('✅ Review gerado com sucesso.');
    return output.trim();
  } catch (err: any) {
    // Limpa arquivo temporário
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

    if (err.status === 2) {
      throw new Error(
        'Erro de autenticação do Claude Code. Verifique seu token/API key.'
      );
    }
    if (err.killed) {
      throw new Error(
        'Claude Code excedeu o timeout de 5 minutos. Tente reduzir o tamanho do diff ou usar um modelo mais rápido (Haiku).'
      );
    }
    throw new Error(`Erro ao executar Claude Code: ${err.message}`);
  }
}

/**
 * Monta o prompt estruturado com delimitadores por arquivo para o modo per-file.
 */
export function buildStructuredPrompt(
  fileDiffs: Map<string, string>,
  customPrompt: string,
  specificationContext?: string
): string {
  let prompt = 'Analise as mudanças de cada arquivo desta Pull Request.\n\n';

  for (const [filePath, diff] of fileDiffs) {
    prompt += `===== ARQUIVO: ${filePath} =====\n${diff}\n\n`;
  }

  if (specificationContext) {
    prompt += `\n===== ESPECIFICAÇÃO (Work Items) =====\n${specificationContext}\n\n`;
  }

  if (customPrompt) {
    prompt += `\nInstruções adicionais do time:\n${customPrompt}\n`;
  }

  return prompt;
}

/**
 * Extrai e parseia o JSON array da resposta do Claude.
 * Lida com markdown fences e texto extra ao redor do JSON.
 */
export function parseFileReviews(rawResponse: string): FileReview[] | null {
  try {
    // Tenta parse direto
    const parsed = JSON.parse(rawResponse.trim());
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Não é JSON puro, tenta extrair
  }

  // Remove markdown fences (```json ... ``` ou ``` ... ```)
  const fenceMatch = rawResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Continua tentando
    }
  }

  // Tenta encontrar o array JSON na resposta (primeiro [ até último ])
  const firstBracket = rawResponse.indexOf('[');
  const lastBracket = rawResponse.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      const jsonStr = rawResponse.substring(firstBracket, lastBracket + 1);
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Parse falhou
    }
  }

  console.log('⚠️ Não foi possível extrair JSON da resposta do Claude. Usando fallback global.');
  return null;
}

/**
 * Converte um FileReview em markdown formatado para postar como comentário.
 */
export function formatFileReviewAsMarkdown(review: FileReview, marker: string): string {
  const severityEmoji: Record<string, string> = {
    critical: '🔴',
    important: '🟡',
    suggestion: '🔵',
  };

  let md = `${marker}\n### 🤖 Claude Review\n\n`;
  md += `**Resumo:** ${review.summary}\n\n`;

  if (review.issues.length > 0) {
    md += '**Problemas:**\n\n';
    for (const issue of review.issues) {
      const emoji = severityEmoji[issue.severity] || '⚪';
      const lineRef = issue.line ? ` (linha ${issue.line})` : '';
      md += `- ${emoji} **${issue.severity}**${lineRef}: ${issue.description}\n`;
    }
    md += '\n';
  }

  if (review.positives) {
    md += `**Pontos positivos:** ${review.positives}\n`;
  }

  if (review.meetsSpecification === false && review.specificationNotes) {
    md += `\n⚠️ **Especificação não atendida:** ${review.specificationNotes}\n`;
  } else if (review.meetsSpecification === true && review.specificationNotes) {
    md += `\n✅ **Especificação:** ${review.specificationNotes}\n`;
  }

  return md;
}
