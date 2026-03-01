/**
 * Azure DevOps API helper — busca diff da PR e posta comentários.
 */

import * as tl from 'azure-pipelines-task-lib/task';
import axios, { AxiosInstance } from 'axios';

export interface AzureDevOpsContext {
  orgUrl: string;
  project: string;
  repoId: string;
  prId: number;
  sourceBranch: string;
  targetBranch: string;
  accessToken: string;
}

/**
 * Coleta variáveis de ambiente do pipeline e monta o contexto.
 * Retorna null se não for um build de PR.
 */
export function getPipelineContext(): AzureDevOpsContext | null {
  const prId = parseInt(
    tl.getVariable('System.PullRequest.PullRequestId') || '0',
    10
  );
  if (!prId) {
    return null;
  }

  const orgUrl = tl.getVariable('System.CollectionUri') || '';
  const project = tl.getVariable('System.TeamProject') || '';
  const repoId = tl.getVariable('Build.Repository.ID') || '';
  const sourceBranch =
    tl.getVariable('System.PullRequest.SourceBranch') || '';
  const targetBranch =
    tl.getVariable('System.PullRequest.TargetBranch') || '';
  const accessToken = tl.getVariable('System.AccessToken') || '';

  if (!orgUrl || !project || !repoId || !accessToken) {
    tl.warning(
      'Variáveis de pipeline incompletas. Certifique-se de que o pipeline tem acesso ao OAuth token.'
    );
    return null;
  }

  return {
    orgUrl: orgUrl.replace(/\/$/, ''),
    project,
    repoId,
    prId,
    sourceBranch,
    targetBranch,
    accessToken,
  };
}

function createClient(ctx: AzureDevOpsContext): AxiosInstance {
  return axios.create({
    baseURL: `${ctx.orgUrl}/${encodeURIComponent(ctx.project)}/_apis`,
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      'Content-Type': 'application/json',
    },
    params: {
      'api-version': '7.1',
    },
  });
}

/**
 * Resolve o nome da branch target a partir das variáveis do pipeline.
 */
function resolveTargetBranch(targetBranch: string): string {
  // Tenta primeiro System.PullRequest.TargetBranchName (mais confiável)
  let target = tl.getVariable('System.PullRequest.TargetBranchName') || '';
  if (!target) {
    target = targetBranch;
    if (target.startsWith('refs/heads/')) {
      target = target.replace('refs/heads/', '');
    }
  }
  return target;
}

/**
 * Obtém os arquivos alterados na PR via git diff local.
 * Usa os refs já disponíveis do checkout do pipeline.
 * O fetch é não-fatal — o checkout step do Azure DevOps já traz os refs necessários.
 */
export function getLocalDiff(
  targetBranch: string,
  fileExtensions: string[],
  excludePaths: string[],
  maxSize: number
): string {
  const target = resolveTargetBranch(targetBranch);

  // Tenta fetch não-fatal — confia nos refs do checkout do pipeline
  try {
    tl.execSync('git', `fetch origin ${target} --depth=1`);
  } catch {
    console.log(`Aviso: Falha ao fazer fetch de origin/${target}. Continuando com refs locais...`);
  }

  // Monta argumentos como array para evitar problemas com aspas
  const diffArgs: string[] = [
    'diff',
    `origin/${target}...HEAD`,
    '--no-color',
    '--unified=3',
    '--diff-filter=AM',
    '--',
  ];

  // Adiciona filtros de extensão (SEM aspas)
  for (const ext of fileExtensions) {
    diffArgs.push(`*.${ext.trim()}`);
  }

  // Adiciona exclusões (SEM aspas)
  for (const p of excludePaths) {
    diffArgs.push(`:(exclude)${p.trim()}/**`);
  }

  try {
    tl.debug(`Executando: git ${diffArgs.join(' ')}`);

    const result = tl.execSync('git', diffArgs);
    let diff = result.stdout || '';

    if (diff.length > maxSize) {
      const originalSize = diff.length;
      diff = diff.substring(0, maxSize);
      tl.warning(`Diff truncado de ${originalSize} para ${maxSize} caracteres.`);
    }

    return diff;
  } catch (err: any) {
    tl.warning(`Erro ao obter diff via git: ${err.message}`);
    return '';
  }
}

/**
 * Posta um comentário como thread na PR.
 */
export async function postPRComment(
  ctx: AzureDevOpsContext,
  content: string,
  status: number = 4
): Promise<void> {
  const client = createClient(ctx);

  const payload = {
    comments: [
      {
        parentCommentId: 0,
        content,
        commentType: 1, // Text
      },
    ],
    status, // 1=Active, 4=Closed
  };

  const url = `/git/repositories/${ctx.repoId}/pullRequests/${ctx.prId}/threads`;

  try {
    await client.post(url, payload);
    console.log('✅ Review postado com sucesso na PR.');
  } catch (err: any) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    tl.warning(
      `Erro ao postar comentário na PR (HTTP ${status}): ${msg}. ` +
        `Verifique se o Build Service tem permissão "Contribute to pull requests".`
    );
  }
}

/**
 * Lista os arquivos alterados na PR via git diff --name-only.
 */
export function getChangedFiles(
  targetBranch: string,
  fileExtensions: string[],
  excludePaths: string[]
): string[] {
  const target = resolveTargetBranch(targetBranch);

  // Fetch não-fatal
  try {
    tl.execSync('git', `fetch origin ${target} --depth=1`);
  } catch {
    console.log(`Aviso: Falha ao fazer fetch de origin/${target}. Continuando com refs locais...`);
  }

  const args: string[] = [
    'diff',
    '--name-only',
    '--diff-filter=AM',
    `origin/${target}...HEAD`,
    '--',
  ];

  for (const ext of fileExtensions) {
    args.push(`*.${ext.trim()}`);
  }

  for (const p of excludePaths) {
    args.push(`:(exclude)${p.trim()}/**`);
  }

  try {
    const result = tl.execSync('git', args);
    const files = (result.stdout || '')
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
    return files;
  } catch (err: any) {
    tl.warning(`Erro ao listar arquivos alterados: ${err.message}`);
    return [];
  }
}

/**
 * Obtém o diff de um arquivo específico.
 */
export function getFileDiff(
  targetBranch: string,
  filePath: string,
  maxSize: number
): string {
  const target = resolveTargetBranch(targetBranch);

  const args = [
    'diff',
    `origin/${target}...HEAD`,
    '--no-color',
    '--unified=3',
    '--',
    filePath,
  ];

  try {
    const result = tl.execSync('git', args);
    let diff = result.stdout || '';

    if (maxSize > 0 && diff.length > maxSize) {
      const originalSize = diff.length;
      diff = diff.substring(0, maxSize);
      tl.warning(`Diff de ${filePath} truncado de ${originalSize} para ${maxSize} caracteres.`);
    }

    return diff;
  } catch (err: any) {
    tl.warning(`Erro ao obter diff de ${filePath}: ${err.message}`);
    return '';
  }
}

/**
 * Posta um comentário vinculado a um arquivo específico na PR.
 * Usa threadContext com filePath para aparecer na aba "Files".
 */
export async function postFileComment(
  ctx: AzureDevOpsContext,
  filePath: string,
  content: string,
  status: number = 4
): Promise<void> {
  const client = createClient(ctx);

  const payload = {
    comments: [
      {
        parentCommentId: 0,
        content,
        commentType: 1,
      },
    ],
    threadContext: {
      filePath: filePath.startsWith('/') ? filePath : `/${filePath}`,
    },
    status, // 1=Active, 4=Closed
  };

  const url = `/git/repositories/${ctx.repoId}/pullRequests/${ctx.prId}/threads`;

  try {
    await client.post(url, payload);
    console.log(`  ✅ Comentário postado em ${filePath}`);
  } catch (err: any) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    tl.warning(`Erro ao postar comentário em ${filePath} (HTTP ${status}): ${msg}`);
  }
}

/**
 * Adiciona uma label à PR.
 */
export async function addLabel(
  ctx: AzureDevOpsContext,
  labelName: string
): Promise<void> {
  const client = createClient(ctx);
  const url = `/git/repositories/${ctx.repoId}/pullRequests/${ctx.prId}/labels`;

  try {
    await client.post(url, { name: labelName });
    console.log(`🏷️ Label "${labelName}" adicionada à PR.`);
  } catch (err: any) {
    // 409 = label já existe, ignora
    if (err.response?.status === 409) {
      tl.debug(`Label "${labelName}" já existe na PR.`);
    } else {
      tl.warning(`Aviso: Não foi possível adicionar label "${labelName}": ${err.message}`);
    }
  }
}

export interface WorkItemInfo {
  id: number;
  title: string;
  description: string;
  acceptanceCriteria: string;
}

/**
 * Obtém os Work Items linkados à PR.
 */
export async function getLinkedWorkItems(
  ctx: AzureDevOpsContext
): Promise<{ id: number; url: string }[]> {
  const client = createClient(ctx);
  const url = `/git/repositories/${ctx.repoId}/pullRequests/${ctx.prId}/workitems`;

  try {
    const response = await client.get(url);
    const items = response.data?.value || [];
    return items.map((item: any) => ({
      id: parseInt(item.id, 10),
      url: item.url || '',
    }));
  } catch (err: any) {
    tl.warning(`Aviso: Não foi possível obter Work Items da PR: ${err.message}`);
    return [];
  }
}

/**
 * Obtém detalhes (título, descrição, critérios de aceite) dos Work Items.
 */
export async function getWorkItemDetails(
  ctx: AzureDevOpsContext,
  ids: number[]
): Promise<WorkItemInfo[]> {
  if (ids.length === 0) return [];

  const client = createClient(ctx);
  const idsParam = ids.join(',');
  const fields = 'System.Title,System.Description,Microsoft.VSTS.Common.AcceptanceCriteria';
  const url = `/wit/workitems?ids=${idsParam}&fields=${fields}`;

  try {
    const response = await client.get(url);
    const items = response.data?.value || [];
    return items.map((item: any) => ({
      id: item.id,
      title: item.fields?.['System.Title'] || '',
      description: stripHtml(item.fields?.['System.Description'] || ''),
      acceptanceCriteria: stripHtml(item.fields?.['Microsoft.VSTS.Common.AcceptanceCriteria'] || ''),
    }));
  } catch (err: any) {
    tl.warning(`Aviso: Não foi possível obter detalhes dos Work Items: ${err.message}`);
    return [];
  }
}

/**
 * Remove tags HTML de um texto (campos de Work Item são retornados em HTML).
 */
export function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Domínios permitidos para webhooks do Teams (Power Automate / Office 365).
 */
const ALLOWED_TEAMS_DOMAINS = [
  '.office.com',
  '.microsoft.com',
  '.logic.azure.com',
  '.azure.com',
];

/**
 * Envia notificação para o Microsoft Teams via webhook (Adaptive Card).
 * Valida que a URL pertence a domínios Microsoft para evitar envio acidental de dados.
 */
export async function sendTeamsNotification(
  webhookUrl: string,
  card: object
): Promise<void> {
  try {
    const urlObj = new URL(webhookUrl);
    const hostname = urlObj.hostname.toLowerCase();
    const isAllowed = ALLOWED_TEAMS_DOMAINS.some((d) => hostname.endsWith(d));

    if (!isAllowed) {
      tl.warning(`Aviso: URL do webhook Teams rejeitada — domínio "${hostname}" não é um domínio Microsoft permitido.`);
      return;
    }

    await axios.post(webhookUrl, card, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15_000,
    });
    console.log('📨 Notificação enviada para o Teams.');
  } catch (err: any) {
    tl.warning(`Aviso: Falha ao enviar notificação para o Teams: ${err.message}`);
  }
}
