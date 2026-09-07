# Himma — private evidence object storage (docs/36 IN-06/VE-01; docs/38
# §2.7/§14). The certified W3 driver speaks SigV4 S3 with server-proxied
# bytes: private bucket, block ALL public access, SSE, versioning, TLS-only
# policy, no public object URLs, no lifecycle expiry (evidence retention is
# the OPEN owner/counsel ruling VE-05 — nothing is deleted automatically).
#
# Having this bucket does NOT enable evidence retrieval: `contentSafetyReady`
# stays false in the application (docs/36 VE-02 — binding).

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" { type = string }
variable "environment" { type = string }
variable "kms_key_id" {
  type    = string
  default = ""
}
variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "evidence" {
  bucket = "${var.name}-evidence-${data.aws_caller_identity.current.account_id}"
  tags   = merge(var.tags, { "himma:environment" = var.environment, "himma:component" = "evidence" })
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket                  = aws_s3_bucket.evidence.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  rule {
    object_ownership = "BucketOwnerEnforced" # ACLs disabled entirely
  }
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_id != "" ? "aws:kms" : "AES256"
      kms_master_key_id = var.kms_key_id != "" ? var.kms_key_id : null
    }
    bucket_key_enabled = var.kms_key_id != ""
  }
}

# TLS-only + deny any public principal (defense in depth over the access block).
data "aws_iam_policy_document" "evidence" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    resources = [aws_s3_bucket.evidence.arn, "${aws_s3_bucket.evidence.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  policy = data.aws_iam_policy_document.evidence.json
}

# The exact object permissions the certified driver needs (put/head/get on
# the evidence prefix; no list-all, no delete — retention is VE-05).
data "aws_iam_policy_document" "evidence_access" {
  statement {
    sid       = "EvidenceObjects"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.evidence.arn}/evidence/*"]
  }
  statement {
    sid       = "EvidenceHead"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.evidence.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["evidence/*"]
    }
  }
}

resource "aws_iam_policy" "evidence_access" {
  name        = "${var.name}-evidence-access"
  description = "Scoped evidence-bucket access for the API task role (put/get/head under evidence/)"
  policy      = data.aws_iam_policy_document.evidence_access.json
}

output "bucket_name" { value = aws_s3_bucket.evidence.bucket }
output "bucket_arn" { value = aws_s3_bucket.evidence.arn }
output "bucket_regional_domain" { value = aws_s3_bucket.evidence.bucket_regional_domain_name }
output "access_policy_arn" { value = aws_iam_policy.evidence_access.arn }
