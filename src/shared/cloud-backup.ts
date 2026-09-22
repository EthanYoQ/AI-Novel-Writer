export interface CloudBackupProjectSessionContext {
  projectId: string
  leaseId: string
  projectPath: string
}

export type CloudBackupBindingMode = 'unconfigured' | 'writable' | 'origin-readonly'

export interface CloudBackupBindingView {
  localProjectId: string
  cloudBookId: string
  localEndpointAccountId: string
  lastSelectedParentGenerationIds: string[]
  mode: CloudBackupBindingMode
  revision: number
}

export interface CloudBackupAccountView {
  accountId: string
  endpoint: string
  username: string
  persistence: 'os-backed' | 'session-only'
}

export interface CloudBackupGenerationView {
  cloudBookId: string
  generationId: string
  parentGenerationIds: string[]
  createdAt: string
  originProjectId: string
  portableSnapshotGeneration: string
  archiveSha256: string
  archiveByteSize: number
  hasSibling: boolean
  siblingGenerationIds: string[]
}

export type CloudBackupOperationState =
  | 'unconfigured'
  | 'connecting'
  | 'connected'
  | 'configured'
  | 'uploading'
  | 'backup-complete'
  | 'listing'
  | 'listed'
  | 'restoring'
  | 'restore-complete'
  | 'binding-not-saved'
  | 'cancelled'
  | 'failed'

export type CloudBackupErrorCode =
  | 'CLOUD_BACKUP_INPUT_INVALID'
  | 'CLOUD_BACKUP_DISCLOSURE_CONFIRMATION_REQUIRED'
  | 'CLOUD_BACKUP_NOT_CONFIGURED'
  | 'CLOUD_BACKUP_CREDENTIAL_UNAVAILABLE'
  | 'CLOUD_BACKUP_BINDING_READ_ONLY'
  | 'CLOUD_BACKUP_BINDING_CONFLICT'
  | 'CLOUD_BACKUP_OPERATION_CONFLICT'
  | 'CLOUD_BACKUP_OPERATION_NOT_FOUND'
  | 'CLOUD_BACKUP_AUTH_FAILED'
  | 'CLOUD_BACKUP_NETWORK_FAILED'
  | 'CLOUD_BACKUP_REMOTE_INVALID'
  | 'CLOUD_BACKUP_ARCHIVE_FAILED'
  | 'CLOUD_BACKUP_RESTORE_FAILED'
  | 'CLOUD_BACKUP_LOCAL_STATE_NOT_SAVED'
  | 'CLOUD_BACKUP_CANCELLED'
  | 'CLOUD_BACKUP_FAILED'

export interface CloudBackupFailure {
  success: false
  state: 'cancelled' | 'failed'
  errorCode: CloudBackupErrorCode
  operationId?: string
}

export interface CloudBackupConnectRequest {
  accountId?: string
  endpoint: string
  username: string
  secret: string
}

export interface CloudBackupConfirmBindingRequest {
  projectSession: CloudBackupProjectSessionContext
  localEndpointAccountId: string
  cloudBookId?: string
  lastSelectedParentGenerationIds: string[]
  expectedRevision: number | null
}

export interface CloudBackupNowRequest {
  operationId: string
  projectSession: CloudBackupProjectSessionContext
  disclosureConfirmed: boolean
}

export interface CloudBackupListRequest {
  localEndpointAccountId: string
  cloudBookId: string
}

export interface CloudBackupRestoreCopyRequest extends CloudBackupListRequest {
  operationId: string
  generationId: string
  targetProjectRoot: string
}

export interface CloudBackupRestoreReceiptView {
  originProjectId: string
  targetProjectId: string
  targetProjectRoot: string
  snapshotGeneration: string
  portableDatabaseSha256: string
  requiresRuntimeFreezeGuard: true
}

export interface CloudBackupChannels {
  'cloud-backup:view': {
    args: [projectSession: CloudBackupProjectSessionContext]
    return: {
      success: true
      state: 'unconfigured' | 'configured'
      binding: CloudBackupBindingView | null
      account: CloudBackupAccountView | null
    } | CloudBackupFailure
  }
  'cloud-backup:connect': {
    args: [request: CloudBackupConnectRequest]
    return: {
      success: true
      state: 'connected'
      account: CloudBackupAccountView
      warning?: 'CLOUD_CREDENTIAL_SESSION_ONLY'
    } | CloudBackupFailure
  }
  'cloud-backup:confirm-binding': {
    args: [request: CloudBackupConfirmBindingRequest]
    return: { success: true; state: 'configured'; binding: CloudBackupBindingView; staleCredentialRetained?: true } | CloudBackupFailure
  }
  'cloud-backup:backup': {
    args: [request: CloudBackupNowRequest]
    return: {
      success: true
      state: 'backup-complete' | 'binding-not-saved'
      operationId: string
      generation: CloudBackupGenerationView
      backupPoint: string
      bindingSaved: boolean
      binding: CloudBackupBindingView | null
    } | CloudBackupFailure
  }
  'cloud-backup:list': {
    args: [request: CloudBackupListRequest]
    return: { success: true; state: 'listed'; generations: CloudBackupGenerationView[] } | CloudBackupFailure
  }
  'cloud-backup:restore-copy': {
    args: [request: CloudBackupRestoreCopyRequest]
    return: {
      success: true
      state: 'restore-complete' | 'binding-not-saved'
      operationId: string
      receipt: CloudBackupRestoreReceiptView
      bindingSaved: boolean
      binding: CloudBackupBindingView | null
      recentProjectUpdated: boolean
    } | CloudBackupFailure
  }
  'cloud-backup:cancel': {
    args: [operationId: string]
    return: { success: true; cancelled: boolean } | CloudBackupFailure
  }
  'cloud-backup:clear-credential': {
    args: [localEndpointAccountId: string]
    return: { success: true; state: 'unconfigured'; affectedBindings: number } | CloudBackupFailure
  }
}
