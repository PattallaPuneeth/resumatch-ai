class OcrDeferredError(Exception):
    """The PDF needs OCR and this process hands OCR to resume-ocr-queue. Not a failure."""


class DocumentParsingError(Exception):
    """Base exception for document parsing failures."""

    error_code: str = "INTERNAL_ERROR"
    safe_message: str = "An error occurred while parsing the resume."

    def __init__(self, message: str | None = None, error_code: str | None = None):
        super().__init__(message or self.safe_message)
        if error_code:
            self.error_code = error_code


class CorruptFileError(DocumentParsingError):
    error_code = "CORRUPT_FILE"
    safe_message = "The uploaded file is corrupt or unreadable. Please upload a valid document."


class EncryptedPdfError(DocumentParsingError):
    error_code = "ENCRYPTED_PDF"
    safe_message = "The PDF is password protected or encrypted. Please upload an unencrypted file."


class TooManyPagesError(DocumentParsingError):
    error_code = "TOO_MANY_PAGES"
    safe_message = "The uploaded document exceeds the maximum page limit."


class TextTooShortAfterOcrError(DocumentParsingError):
    error_code = "TEXT_TOO_SHORT_AFTER_OCR"
    safe_message = (
        "The document contains insufficient text even after OCR processing. "
        "Please provide a clearer, higher-quality file."
    )


class UnsupportedTypeError(DocumentParsingError):
    error_code = "UNSUPPORTED_TYPE"
    safe_message = "Unsupported file format. Only PDF and DOCX files are supported."


class StorageObjectNotFoundError(DocumentParsingError):
    error_code = "STORAGE_OBJECT_NOT_FOUND"
    safe_message = "The resume file was not found in storage."
