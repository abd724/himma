# Himma — Terraform remote-state bootstrap, applied ONCE per WORKLOAD account
# with LOCAL state (docs/38 §18): an encrypted, versioned, private S3 bucket
# with S3-native locking (Terraform ≥ 1.10 `use_lockfile`), TLS-only policy,
# and lifecycle protection of state versions. Staging and production state
# live in different accounts and therefore different buckets by construction.
#
#   cd infra/terraform/bootstrap
#   terraform init && terraform apply -var environment=staging -var expected_account_id=<staging-account-id>
#
# The management account is never a target (allowed_account_ids pins the workload account).

terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}
variable "expected_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must be a 12-digit AWS account id."
  }
}
variable "region" {
  type    = string
  default = "me-central-1"
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.expected_account_id]
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "state" {
  bucket = "himma-${var.environment}-tfstate-${data.aws_caller_identity.current.account_id}"
  tags   = { "himma:project" = "himma", "himma:environment" = var.environment, "himma:component" = "tfstate" }
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "state" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state.json
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "keep-state-history"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 365
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

output "state_bucket" { value = aws_s3_bucket.state.bucket }
output "backend_hcl" {
  description = "Paste into infra/terraform/envs/<env>/backend.hcl"
  value       = "bucket = \"${aws_s3_bucket.state.bucket}\"\nkey = \"stacks/himma/terraform.tfstate\"\nregion = \"${var.region}\"\nencrypt = true\nuse_lockfile = true"
}
