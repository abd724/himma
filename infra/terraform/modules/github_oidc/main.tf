# Himma — GitHub Actions → AWS via OIDC federation (docs/38 §11; docs/36
# IN-11/SE-01). NO long-lived access keys anywhere. Two roles per workload
# account, both trust ONLY this repository:
#   build  — push images to ECR (any branch/PR of the repository);
#   deploy — run the migration task, update the api/worker services, deploy
#            static sites — trusted ONLY from the GitHub *environment* named
#            after this account's environment (staging | production), which
#            is where the manual production approval lives.
# Neither role can touch IAM, Organizations, secrets VALUES, or RDS data.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" { type = string }
variable "environment" { type = string }
variable "github_repository" {
  type        = string
  description = "owner/repo that may assume the roles (e.g. himma-app/himma)."
}
variable "ecr_repository_arn" { type = string }
variable "ecs_cluster_arn" { type = string }
variable "ecs_service_arns" { type = list(string) }
variable "task_definition_families" {
  type        = list(string)
  description = "Family ARNs (without revision) the deploy role may register/run."
}
variable "execution_role_arns" { type = list(string) }
variable "task_role_arns" { type = list(string) }
variable "static_deploy_policy_arns" {
  type    = list(string)
  default = []
}
variable "log_group_arn" { type = string }
variable "create_build_role" {
  type        = bool
  description = "The build (ECR push) role lives in the staging account only — production pulls the SAME immutable image via cross-account ECR read."
  default     = true
}
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  tags = merge(var.tags, { "himma:environment" = var.environment, "himma:component" = "github-oidc" })
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # GitHub's OIDC provider thumbprints are not used for trust by AWS anymore
  # (AWS validates against the provider's CA); a placeholder is still required.
  thumbprint_list = ["ffffffffffffffffffffffffffffffffffffffff"]
  tags            = local.tags
}

data "aws_iam_policy_document" "build_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:*"]
    }
  }
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # ONLY the GitHub environment named after this account may deploy here.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${var.environment}"]
    }
  }
}

resource "aws_iam_role" "build" {
  count                = var.create_build_role ? 1 : 0
  name                 = "${var.name}-github-build"
  assume_role_policy   = data.aws_iam_policy_document.build_trust.json
  max_session_duration = 3600
  tags                 = local.tags
}

data "aws_iam_policy_document" "build" {
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid    = "EcrPushThisRepositoryOnly"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload",
      "ecr:PutImage", "ecr:UploadLayerPart", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages", "ecr:DescribeImageScanFindings",
    ]
    resources = [var.ecr_repository_arn]
  }
}

resource "aws_iam_role_policy" "build" {
  count  = var.create_build_role ? 1 : 0
  name   = "ecr-push"
  role   = aws_iam_role.build[0].id
  policy = data.aws_iam_policy_document.build.json
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name}-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.deploy_trust.json
  max_session_duration = 3600
  tags                 = local.tags
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrRead"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "EcrReadThisRepository"
    effect    = "Allow"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:DescribeImages", "ecr:BatchCheckLayerAvailability"]
    resources = [var.ecr_repository_arn]
  }
  statement {
    sid       = "RegisterTaskDefinitions"
    effect    = "Allow"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "ecs:ListTaskDefinitions"]
    resources = ["*"] # RegisterTaskDefinition does not support resource-level scoping
  }
  statement {
    sid       = "PassOnlyHimmaTaskRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = concat(var.execution_role_arns, var.task_role_arns)
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    sid       = "UpdateHimmaServices"
    effect    = "Allow"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = var.ecs_service_arns
  }
  statement {
    sid       = "RunJobTasks"
    effect    = "Allow"
    actions   = ["ecs:RunTask"]
    resources = var.task_definition_families
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.ecs_cluster_arn]
    }
  }
  statement {
    sid       = "ObserveTasks"
    effect    = "Allow"
    actions   = ["ecs:DescribeTasks", "ecs:ListTasks", "ecs:DescribeClusters"]
    resources = ["*"]
  }
  statement {
    sid       = "ReadJobLogs"
    effect    = "Allow"
    actions   = ["logs:GetLogEvents", "logs:FilterLogEvents", "logs:DescribeLogStreams"]
    resources = [var.log_group_arn, "${var.log_group_arn}:*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "ecs-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}

resource "aws_iam_role_policy_attachment" "deploy_static" {
  for_each   = toset(var.static_deploy_policy_arns)
  role       = aws_iam_role.deploy.name
  policy_arn = each.value
}

output "build_role_arn" { value = var.create_build_role ? aws_iam_role.build[0].arn : "" }
output "deploy_role_arn" { value = aws_iam_role.deploy.arn }
output "oidc_provider_arn" { value = aws_iam_openid_connect_provider.github.arn }
