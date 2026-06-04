import boto3
from core.config import settings

s3_client = boto3.client(
    "s3",
    aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
    aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
    region_name=settings.AWS_REGION,
)

def generate_presigned_upload_url(s3_key: str, content_type: str, expiration: int = 3600) -> str:
    """
    Generate a presigned URL to upload an S3 object
    :param s3_key: string
    :param content_type: string
    :param expiration: Time in seconds for the presigned URL to remain valid
    :return: Presigned URL as string. If error, returns None.
    """
    try:
        response = s3_client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": settings.S3_BUCKET_NAME, 
                "Key": s3_key,
                "ContentType": content_type
            },
            ExpiresIn=expiration,
        )
    except Exception as e:
        print(f"Error generating presigned URL: {e}")
        return None
    return response

def generate_presigned_download_url(s3_key: str, expires_in: int = 3600) -> str:
    """Generate a presigned URL for reading a file from S3."""
    return s3_client.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": settings.S3_BUCKET_NAME,
            "Key": s3_key,
        },
        ExpiresIn=expires_in,
    )


# --- Multipart upload helpers ---

def create_multipart_upload(s3_key: str, content_type: str) -> str:
    """Initiate a multipart upload and return the upload_id."""
    response = s3_client.create_multipart_upload(
        Bucket=settings.S3_BUCKET_NAME,
        Key=s3_key,
        ContentType=content_type,
    )
    return response["UploadId"]


def generate_presigned_part_url(s3_key: str, upload_id: str, part_number: int, expiration: int = 3600) -> str:
    """Generate a presigned URL for uploading a single part."""
    return s3_client.generate_presigned_url(
        "upload_part",
        Params={
            "Bucket": settings.S3_BUCKET_NAME,
            "Key": s3_key,
            "UploadId": upload_id,
            "PartNumber": part_number,
        },
        ExpiresIn=expiration,
    )


def complete_multipart_upload(s3_key: str, upload_id: str, parts: list[dict]) -> None:
    """
    Finalize a multipart upload.
    parts: [{"PartNumber": int, "ETag": str}, ...]
    """
    s3_client.complete_multipart_upload(
        Bucket=settings.S3_BUCKET_NAME,
        Key=s3_key,
        UploadId=upload_id,
        MultipartUpload={"Parts": parts},
    )


def abort_multipart_upload(s3_key: str, upload_id: str) -> None:
    """Abort a multipart upload — frees partial S3 storage."""
    try:
        s3_client.abort_multipart_upload(
            Bucket=settings.S3_BUCKET_NAME,
            Key=s3_key,
            UploadId=upload_id,
        )
    except Exception:
        pass