/**
 * Claude PR Reviewer — Azure DevOps Extension v2.0.0
 *
 * Entry point da task. Orquestra:
 *  1. Leitura dos inputs da task
 *  2. Coleta do diff da PR (global ou per-file)
 *  3. Coleta de especificações dos Work Items linkados (se houver)
 *  4. Instalação do Claude Code CLI
 *  5. Execução do review
 *  6. Publicação dos comentários na PR (por arquivo ou global)
 *  7. Notificação no Teams (se configurado)
 */

import * as tl from 'azure-pipelines-task-lib/task';
import {
  AzureDevOpsContext,
  getPipelineContext,
  getLocalDiff,
  getChangedFiles,
  getFileDiff,
  postPRComment,
  postFileComment,
  deleteExistingComments,
  addLabel,
  getLinkedWorkItems,
  getWorkItemDetails,
  sendTeamsNotification,
  WorkItemInfo,
} from './azuredevops';
import {
  installClaudeCode,
  runReview,
  buildStructuredPrompt,
  parseFileReviews,
  formatFileReviewAsMarkdown,
  FileReview,
  ClaudeCodeOptions,
} from './claude-runner';
import { getPrompt, ReviewPrompt } from './prompts';

const REVIEW_MARKER = '<!-- claude-pr-review -->';

async function run(): Promise<void> {
  try {
    // ─── 1. Inputs da task ──────────────────────────────────
    const authMethod = tl.getInput('authMethod', true) as 'subscription' | 'apikey';
    const oauthToken = tl.getInput('oauthToken', false);
    const apiKey = tl.getInput('apiKey', false);
    const model = tl.getInput('model', false) || 'claude-sonnet-4-5-20250929';
    const reviewLanguage = tl.getInput('reviewLanguage', false) || 'pt-br';
    const fileExtensions = (tl.getInput('fileExtensions', false) || 'ts,js,py,php,vue,cs,java,go,md,json,yml,yaml')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const excludePaths = (tl.getInput('excludePaths', false) || 'node_modules,dist,build,vendor')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const maxDiffSize = parseInt(tl.getInput('maxDiffSize', false) || '50000', 10);
    const maxFileDiffSize = parseInt(tl.getInput('maxFileDiffSize', false) || '10000', 10);
    const customPrompt = tl.getInput('customPrompt', false) || '';
    const maxTurns = parseInt(tl.getInput('maxTurns', false) || '1', 10);
    const failOnError = tl.getBoolInput('failOnError', false);
    const postComment = tl.getBoolInput('postComment', false);
    const perFileReview = tl.getBoolInput('perFileReview', false);
    const teamsWebhookUrl = tl.getInput('teamsWebhookUrl', false) || '';

    const prompt = getPrompt(reviewLanguage);

    console.log('═══════════════════════════════════════════');
    console.log('  🤖 Claude PR Reviewer v2.0.0');
    console.log('═══════════════════════════════════════════');
    console.log(`  Modelo:       ${model}`);
    console.log(`  Idioma:       ${reviewLanguage}`);
    console.log(`  Auth:         ${authMethod}`);
    console.log(`  Modo:         ${perFileReview ? 'Per-file' : 'Global'}`);
    console.log(`  Extensões:    ${fileExtensions.join(', ')}`);
    console.log(`  Max diff:     ${maxDiffSize} chars`);
    if (perFileReview) {
      console.log(`  Max/arquivo:  ${maxFileDiffSize} chars`);
    }
    if (teamsWebhookUrl) {
      console.log('  Teams:        Habilitado');
    }
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

    // ─── 3. Instalar Claude Code ──────────────────────────────
    installClaudeCode();

    const claudeOptions: ClaudeCodeOptions = {
      authMethod,
      oauthToken: oauthToken || undefined,
      apiKey: apiKey || undefined,
      model,
      maxTurns,
    };

    // ─── 4. Executar review ──────────────────────────────────
    if (perFileReview) {
      await runPerFileReview(
        ctx, claudeOptions, prompt, fileExtensions, excludePaths,
        maxDiffSize, maxFileDiffSize, customPrompt, model, postComment, teamsWebhookUrl
      );
    } else {
      await runGlobalReview(
        ctx, claudeOptions, prompt, fileExtensions, excludePaths,
        maxDiffSize, customPrompt, model, postComment, teamsWebhookUrl
      );
    }

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

/**
 * Determina o status da thread com base nas severidades dos issues.
 * Active (1) se tem critical ou important, Closed (4) se só suggestion.
 */
function determineThreadStatus(review: FileReview): number {
  const hasCriticalOrImportant = review.issues.some(
    (i) => i.severity === 'critical' || i.severity === 'important'
  );
  return hasCriticalOrImportant ? 1 : 4; // 1=Active, 4=Closed
}

/**
 * Coleta especificações dos Work Items linkados à PR.
 * Retorna string formatada com título, descrição e critérios de aceite.
 * Retorna string vazia se não houver WIs ou se falhar.
 */
async function buildSpecificationContext(ctx: AzureDevOpsContext): Promise<string> {
  console.log('📋 Verificando Work Items linkados...');

  const workItems = await getLinkedWorkItems(ctx);
  if (workItems.length === 0) {
    console.log('  Nenhum Work Item linkado à PR.');
    return '';
  }

  console.log(`  ${workItems.length} Work Item(s) encontrado(s): ${workItems.map((w) => `#${w.id}`).join(', ')}`);

  const details = await getWorkItemDetails(ctx, workItems.map((w) => w.id));
  if (details.length === 0) {
    return '';
  }

  let context = '';
  for (const wi of details) {
    context += `--- Work Item #${wi.id}: ${wi.title} ---\n`;
    if (wi.description) {
      context += `Descrição:\n${wi.description}\n\n`;
    }
    if (wi.acceptanceCriteria) {
      context += `Critérios de Aceite:\n${wi.acceptanceCriteria}\n\n`;
    }
  }

  if (context) {
    console.log(`  📄 Especificações coletadas de ${details.length} Work Item(s).\n`);
  }

  return context;
}

/**
 * Monta um Adaptive Card para notificação no Microsoft Teams.
 */
function buildTeamsCard(
  ctx: AzureDevOpsContext,
  reviews: FileReview[] | null,
  model: string,
  reviewText?: string
): object {
  const facts: { title: string; value: string }[] = [
    { title: 'PR', value: `#${ctx.prId}: ${ctx.sourceBranch} → ${ctx.targetBranch}` },
  ];

  if (reviews) {
    let critical = 0;
    let important = 0;
    let suggestion = 0;
    let filesWithIssues = 0;

    for (const review of reviews) {
      if (review.hasFeedback && review.issues.length > 0) {
        filesWithIssues++;
        for (const issue of review.issues) {
          if (issue.severity === 'critical') critical++;
          else if (issue.severity === 'important') important++;
          else suggestion++;
        }
      }
    }

    facts.push({ title: 'Arquivos', value: `${reviews.length} analisados, ${filesWithIssues} com feedback` });
    if (critical > 0) facts.push({ title: '🔴 Crítico', value: String(critical) });
    if (important > 0) facts.push({ title: '🟡 Importante', value: String(important) });
    if (suggestion > 0) facts.push({ title: '🔵 Sugestão', value: String(suggestion) });
  } else if (reviewText) {
    const lines = reviewText.split('\n').length;
    facts.push({ title: 'Modo', value: 'Review Global' });
    facts.push({ title: 'Tamanho', value: `${lines} linhas` });
  }

  facts.push({ title: 'Modelo', value: model });

  const prUrl = `${ctx.orgUrl}/${encodeURIComponent(ctx.project)}/_git/${encodeURIComponent(ctx.repoId)}/pullrequest/${ctx.prId}`;

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: '🤖 Claude PR Review',
              weight: 'Bolder',
              size: 'Medium',
            },
            {
              type: 'FactSet',
              facts,
            },
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: 'Ver PR',
              url: prUrl,
            },
          ],
        },
      },
    ],
  };
}

/**
 * Modo per-file: coleta diff por arquivo, uma chamada ao Claude com JSON estruturado,
 * posta comentários individuais na aba "Files" da PR.
 */
async function runPerFileReview(
  ctx: AzureDevOpsContext,
  options: ClaudeCodeOptions,
  prompt: ReviewPrompt,
  fileExtensions: string[],
  excludePaths: string[],
  maxDiffSize: number,
  maxFileDiffSize: number,
  customPrompt: string,
  model: string,
  postComment: boolean,
  teamsWebhookUrl: string
): Promise<void> {
  // 1. Listar arquivos alterados
  console.log('📂 Listando arquivos alterados...');
  const files = getChangedFiles(ctx.targetBranch, fileExtensions, excludePaths);

  if (files.length === 0) {
    console.log(prompt.noChanges);
    if (postComment) {
      await postPRComment(ctx, REVIEW_MARKER + '\n' + prompt.reviewHeader + prompt.noChanges + prompt.reviewFooter(model));
    }
    return;
  }

  console.log(`📊 ${files.length} arquivo(s) alterado(s): ${files.join(', ')}\n`);

  // 2. Coletar diff de cada arquivo
  console.log('📂 Coletando diffs por arquivo...');
  const fileDiffs = new Map<string, string>();
  let totalSize = 0;

  for (const file of files) {
    if (totalSize >= maxDiffSize) {
      console.log(`⚠️ Limite total de diff atingido (${maxDiffSize} chars). Arquivos restantes ignorados.`);
      break;
    }

    const diff = getFileDiff(ctx.targetBranch, file, maxFileDiffSize);
    if (diff && diff.trim().length > 0) {
      fileDiffs.set(file, diff);
      totalSize += diff.length;
    }
  }

  if (fileDiffs.size === 0) {
    console.log(prompt.noChanges);
    return;
  }

  console.log(`📊 Diffs coletados: ${fileDiffs.size} arquivo(s), ${totalSize} caracteres total\n`);

  // 3. Coletar especificações dos Work Items (se houver)
  const specificationContext = await buildSpecificationContext(ctx);
  const hasSpec = specificationContext.length > 0;

  // 4. Montar prompt e chamar Claude (uma única chamada)
  const structuredPrompt = buildStructuredPrompt(fileDiffs, customPrompt, specificationContext || undefined);
  const systemPrompt = hasSpec ? prompt.perFileSystemWithSpec : prompt.perFileSystem;
  const rawReview = runReview(structuredPrompt, systemPrompt, '', options);

  // Salva o review como variável de saída
  tl.setVariable('ClaudeReviewOutput', rawReview, false, true);

  // 5. Parsear resposta JSON
  const fileReviews = parseFileReviews(rawReview);

  if (!fileReviews) {
    // Fallback: postar como comentário global
    console.log('⚠️ Fallback: postando review como comentário global...');
    if (postComment) {
      const fullComment = REVIEW_MARKER + '\n' + prompt.reviewHeader + rawReview + prompt.reviewFooter(model);
      await postPRComment(ctx, fullComment);
    }
    return;
  }

  console.log(`✅ JSON parseado: ${fileReviews.length} arquivo(s) analisado(s)\n`);

  if (!postComment) {
    console.log('📝 Review gerado (postComment desabilitado):');
    console.log('─'.repeat(50));
    for (const review of fileReviews) {
      if (review.hasFeedback) {
        console.log(`\n📄 ${review.file}:`);
        console.log(formatFileReviewAsMarkdown(review, REVIEW_MARKER));
      }
    }
    console.log('─'.repeat(50));
    return;
  }

  // 6. Limpar reviews anteriores
  console.log('🗑️ Limpando reviews anteriores...');
  await deleteExistingComments(ctx, REVIEW_MARKER);

  // 7. Postar comentários por arquivo com status condicional
  console.log('\n💬 Postando reviews por arquivo...');
  let filesWithFeedback = 0;

  for (const review of fileReviews) {
    if (review.hasFeedback && review.issues.length > 0) {
      const markdown = formatFileReviewAsMarkdown(review, REVIEW_MARKER);
      const status = determineThreadStatus(review);
      await postFileComment(ctx, review.file, markdown, status);
      filesWithFeedback++;
    }
  }

  // 8. Postar resumo global
  const summaryComment = buildSummaryComment(fileReviews, model, prompt, hasSpec);
  await postPRComment(ctx, summaryComment);

  // 9. Adicionar label
  await addLabel(ctx, 'AI-Reviewed');

  // 10. Notificar Teams (se configurado)
  if (teamsWebhookUrl) {
    console.log('\n📨 Enviando notificação para o Teams...');
    const card = buildTeamsCard(ctx, fileReviews, model);
    await sendTeamsNotification(teamsWebhookUrl, card);
  }

  console.log(`\n✅ Review per-file concluído: ${filesWithFeedback} arquivo(s) com feedback.`);
}

/**
 * Modo global (legado): coleta diff único, uma chamada ao Claude, posta um comentário global.
 */
async function runGlobalReview(
  ctx: AzureDevOpsContext,
  options: ClaudeCodeOptions,
  prompt: ReviewPrompt,
  fileExtensions: string[],
  excludePaths: string[],
  maxDiffSize: number,
  customPrompt: string,
  model: string,
  postComment: boolean,
  teamsWebhookUrl: string
): Promise<void> {
  console.log('📂 Coletando diff dos arquivos alterados...');
  let diff = getLocalDiff(ctx.targetBranch, fileExtensions, excludePaths, maxDiffSize);

  if (!diff || diff.trim().length === 0) {
    console.log(prompt.noChanges);
    if (postComment) {
      await postPRComment(ctx, prompt.reviewHeader + prompt.noChanges + prompt.reviewFooter(model));
    }
    return;
  }

  if (diff.length >= maxDiffSize) {
    console.log(prompt.diffTooLarge);
    diff += `\n\n[${prompt.diffTooLarge}]`;
  }

  console.log(`📊 Diff coletado: ${diff.length} caracteres\n`);

  const reviewText = runReview(diff, prompt.system, customPrompt, options);
  const fullComment = prompt.reviewHeader + reviewText + prompt.reviewFooter(model);

  if (postComment) {
    console.log('\n💬 Postando review na PR...');
    await postPRComment(ctx, fullComment);
  } else {
    console.log('\n📝 Review gerado (postComment desabilitado):');
    console.log('─'.repeat(50));
    console.log(reviewText);
    console.log('─'.repeat(50));
  }

  tl.setVariable('ClaudeReviewOutput', reviewText, false, true);

  // Notificar Teams (se configurado)
  if (teamsWebhookUrl) {
    console.log('\n📨 Enviando notificação para o Teams...');
    const card = buildTeamsCard(ctx, null, model, reviewText);
    await sendTeamsNotification(teamsWebhookUrl, card);
  }
}

/**
 * Monta o comentário de resumo global com tabela de severidades.
 */
function buildSummaryComment(
  reviews: FileReview[],
  model: string,
  prompt: ReviewPrompt,
  hasSpecification: boolean = false
): string {
  let critical = 0;
  let important = 0;
  let suggestion = 0;
  let filesWithIssues = 0;
  let specNotMet = 0;

  for (const review of reviews) {
    if (review.hasFeedback && review.issues.length > 0) {
      filesWithIssues++;
      for (const issue of review.issues) {
        if (issue.severity === 'critical') critical++;
        else if (issue.severity === 'important') important++;
        else suggestion++;
      }
    }
    if (hasSpecification && review.meetsSpecification === false) {
      specNotMet++;
    }
  }

  const totalIssues = critical + important + suggestion;

  let md = REVIEW_MARKER + '\n';
  md += prompt.reviewHeader;
  md += `**${reviews.length}** arquivo(s) analisado(s), **${filesWithIssues}** com feedback.\n\n`;

  if (totalIssues > 0) {
    md += '| Severidade | Quantidade |\n';
    md += '|------------|------------|\n';
    if (critical > 0) md += `| 🔴 Crítico | ${critical} |\n`;
    if (important > 0) md += `| 🟡 Importante | ${important} |\n`;
    if (suggestion > 0) md += `| 🔵 Sugestão | ${suggestion} |\n`;
    md += `| **Total** | **${totalIssues}** |\n\n`;
    md += 'Veja os comentários detalhados na aba **Files** desta PR.\n';
  } else {
    md += '✅ Nenhum problema encontrado nos arquivos analisados.\n';
  }

  if (hasSpecification) {
    md += '\n### 📋 Validação de Especificação\n\n';
    if (specNotMet > 0) {
      md += `⚠️ **${specNotMet}** arquivo(s) não atendem completamente à especificação dos Work Items. Veja os comentários por arquivo para detalhes.\n`;
    } else {
      md += '✅ Todos os arquivos analisados atendem à especificação dos Work Items linkados.\n';
    }
  }

  md += prompt.reviewFooter(model);
  return md;
}

run();
