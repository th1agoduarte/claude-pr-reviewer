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
    const diffCmdStr = diffArgs.join(' ');
    tl.debug(`Executando: git ${diffCmdStr}`);

    const result = tl.execSync('git', diffCmdStr);
    let diff = result.stdout || '';

    if (diff.length > maxSize) {
      tl.warning(`Diff truncado de ${diff.length} para ${maxSize} caracteres.`);
      diff = diff.substring(0, maxSize);
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
  content: string
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
    status: 4, // Closed (informativo, não bloqueia)
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
