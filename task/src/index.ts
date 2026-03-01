/**
 * Claude PR Reviewer — Azure DevOps Extension
 *
 * Entry point da task. Orquestra:
 *  1. Leitura dos inputs da task
 *  2. Coleta do diff da PR
 *  3. Instalação do Claude Code CLI
 *  4. Execução do review
 *  5. Publicação do comentário na PR
 */

import * as tl from 'azure-pipelines-task-lib/task';
import { getPipelineContext, getLocalDiff, postPRComment } from './azuredevops';
import { installClaudeCode, runReview, ClaudeCodeOptions } from './claude-runner';
import { getPrompt } from './prompts';

async function run(): Promise<void> {
  try {
    // ─── 1. Inputs da task ──────────────────────────────────
    const authMethod = tl.getInput('authMethod', true) as 'subscription' | 'apikey';
    const oauthToken = tl.getInput('oauthToken', false);
    const apiKey = tl.getInput('apiKey', false);
    const model = tl.getInput('model', false) || 'claude-sonnet-4-5-20250929';
    const reviewLanguage = tl.getInput('reviewLanguage', false) || 'pt-br';
    const fileExtensions = (tl.getInput('fileExtensions', false) || 'ts,js,py,php,vue,cs,java,go')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const excludePaths = (tl.getInput('excludePaths', false) || 'node_modules,dist,build,vendor')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const maxDiffSize = parseInt(tl.getInput('maxDiffSize', false) || '30000', 10);
    const customPrompt = tl.getInput('customPrompt', false) || '';
    const maxTurns = parseInt(tl.getInput('maxTurns', false) || '1', 10);
    const failOnError = tl.getBoolInput('failOnError', false);
    const postComment = tl.getBoolInput('postComment', false);

    const prompt = getPrompt(reviewLanguage);

    console.log('═══════════════════════════════════════════');
    console.log('  🤖 Claude PR Reviewer');
    console.log('═══════════════════════════════════════════');
    console.log(`  Modelo:     ${model}`);
    console.log(`  Idioma:     ${reviewLanguage}`);
    console.log(`  Auth:       ${authMethod}`);
    console.log(`  Extensões:  ${fileExtensions.join(', ')}`);
    console.log(`  Max diff:   ${maxDiffSize} chars`);
    console.log('═══════════════════════════════════════════\n');

    // ─── 2. Contexto da PR ──────────────────────────────────
    const ctx = getPipelineContext();

    if (!ctx) {
      tl.setResult(
        tl.TaskResult.Skipped,
        'Este build não é de uma Pull Request. Task ignorada.'
      );
      return;
    }

    console.log(`📋 PR #${ctx.prId}: ${ctx.sourceBranch} → ${ctx.targetBranch}\n`);

    // ─── 3. Coletar diff ────────────────────────────────────
    console.log('📂 Coletando diff dos arquivos alterados...');
    let diff = getLocalDiff(ctx.targetBranch, fileExtensions, excludePaths, maxDiffSize);

    if (!diff || diff.trim().length === 0) {
      console.log(prompt.noChanges);
      if (postComment) {
        await postPRComment(ctx, prompt.reviewHeader + prompt.noChanges + prompt.reviewFooter(model));
      }
      tl.setResult(tl.TaskResult.Succeeded, prompt.noChanges);
      return;
    }

    // Verifica se foi truncado
    if (diff.length >= maxDiffSize) {
      console.log(prompt.diffTooLarge);
      diff += `\n\n[${prompt.diffTooLarge}]`;
    }

    console.log(`📊 Diff coletado: ${diff.length} caracteres\n`);

    // ─── 4. Instalar e rodar Claude Code ────────────────────
    installClaudeCode();

    const claudeOptions: ClaudeCodeOptions = {
      authMethod,
      oauthToken: oauthToken || undefined,
      apiKey: apiKey || undefined,
      model,
      maxTurns,
    };

    const reviewText = runReview(diff, prompt.system, customPrompt, claudeOptions);

    // ─── 5. Postar na PR ────────────────────────────────────
    const fullComment =
      prompt.reviewHeader + reviewText + prompt.reviewFooter(model);

    if (postComment) {
      console.log('\n💬 Postando review na PR...');
      await postPRComment(ctx, fullComment);
    } else {
      console.log('\n📝 Review gerado (postComment desabilitado):');
      console.log('─'.repeat(50));
      console.log(reviewText);
      console.log('─'.repeat(50));
    }

    // Salva o review como variável de saída para uso posterior no pipeline
    tl.setVariable('ClaudeReviewOutput', reviewText, false, true);

    tl.setResult(tl.TaskResult.Succeeded, 'Review concluído com sucesso! 🎉');
  } catch (err: any) {
    const failOnError = tl.getBoolInput('failOnError', false);
    const message = `❌ Erro: ${err.message}`;

    console.error(message);

    if (failOnError) {
      tl.setResult(tl.TaskResult.Failed, message);
    } else {
      tl.warning(message);
      tl.setResult(
        tl.TaskResult.SucceededWithIssues,
        'Review falhou mas pipeline continua (failOnError=false).'
      );
    }
  }
}

run();
