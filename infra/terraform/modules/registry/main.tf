# Himma — ECR repository for the ONE backend image (docs/37 §4; docs/38 §8).
# Immutable tags (a git SHA is pushed once), scan on push (docs/36 SE-03),
# encrypted, lifecycle keeps the last 30 tagged images.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" { type = string }
variable "environment" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_ecr_repository" "backend" {
  name                 = "${var.name}/backend"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
  tags = merge(var.tags, { "himma:environment" = var.environment, "himma:component" = "registry" })
}

resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "expire untagged layers after 7 days"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "keep the last 30 SHA-tagged images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
        action       = { type = "expire" }
      }
    ]
  })
}

output "repository_url" { value = aws_ecr_repository.backend.repository_url }
output "repository_arn" { value = aws_ecr_repository.backend.arn }
output "repository_name" { value = aws_ecr_repository.backend.name }
