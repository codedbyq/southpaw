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