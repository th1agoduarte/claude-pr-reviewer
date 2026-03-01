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
 * Configura credencial git usando o System.AccessToken do pipeline.
 * Necessário para que git fetch funcione no agente.
 */
function configureGitAuth(accessToken: string): void {
  const orgUrl = tl.getVariable('System.CollectionUri') || '';
  if (!orgUrl || !accessToken) return;

  try {
    const base64Token = Buffer.from(`:${accessToken}`).toString('base64');
    const header = `AUTHORIZATION: Basic ${base64Token}`;
    tl.execSync('git', `config http.extraheader "${header}"`);
    tl.debug('Git auth configurado via extraheader.');
  } catch {
    tl.debug('Não foi possível configurar git auth.');
  }
}

/**
 * Obtém os arquivos alterados na PR via git diff local.
 * Mais confiável e rápido que chamar a REST API.
 */
export function getLocalDiff(
  targetBranch: string,
  fileExtensions: string[],
  excludePaths: string[],
  maxSize: number,
  accessToken?: string
): string {
  // Monta o filtro de extensões para o git diff
  const extPatterns = fileExtensions.map((ext) => `'*.${ext.trim()}'`).join(' ');

  // Monta exclusões
  const excludeArgs = excludePaths
    .map((p) => `':(exclude)${p.trim()}/**'`)
    .join(' ');

  // Normaliza o nome da branch target
  let target = targetBranch;
  if (target.startsWith('refs/heads/')) {
    target = target.replace('refs/heads/', '');
  }

  // Configura autenticação git para o fetch
  if (accessToken) {
    configureGitAuth(accessToken);
  }

  try {
    // Tenta buscar a branch target para garantir que temos as refs
    tl.execSync('git', `fetch origin ${target} --depth=1`);
  } catch {
    tl.debug(`Não foi possível fazer fetch de origin/${target}, tentando com refs disponíveis.`);
  }

  try {
    const diffCmd = `diff origin/${target}...HEAD --no-color --unified=3 -- ${extPatterns} ${excludeArgs}`;
    tl.debug(`Executando: git ${diffCmd}`);

    const result = tl.execSync('git', diffCmd);
    let diff = result.stdout || '';

    if (diff.length > maxSize) {
      diff = diff.substring(0, maxSize);
      tl.warning(`Diff truncado de ${diff.length} para ${maxSize} caracteres.`);
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
