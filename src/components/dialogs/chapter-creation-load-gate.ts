export interface ChapterCreationLoadToken {
  readonly sequence: number
  readonly projectPath: string
}

/** 将项目身份、请求先后顺序和组件生命周期合并为一个提交门禁。 */
export class ChapterCreationLoadGate {
  private sequence = 0

  begin(projectPath: string): ChapterCreationLoadToken {
    this.sequence += 1
    return Object.freeze({ sequence: this.sequence, projectPath })
  }

  isCurrent(token: ChapterCreationLoadToken, currentProjectPath?: string): boolean {
    return token.sequence === this.sequence && token.projectPath === currentProjectPath
  }

  invalidate(token: ChapterCreationLoadToken): void {
    if (token.sequence === this.sequence) this.sequence += 1
  }
}
