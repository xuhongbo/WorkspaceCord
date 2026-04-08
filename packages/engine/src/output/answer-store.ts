const pendingAnswersStore = new Map<string, Map<number, string>>();
const questionCountStore = new Map<string, number>();

export function setPendingAnswer(sessionId: string, questionIndex: number, answer: string): void {
  if (!pendingAnswersStore.has(sessionId)) {
    pendingAnswersStore.set(sessionId, new Map());
  }
  pendingAnswersStore.get(sessionId)!.set(questionIndex, answer);
}

export function getPendingAnswers(sessionId: string): Map<number, string> | undefined {
  return pendingAnswersStore.get(sessionId);
}

export function clearPendingAnswers(sessionId: string): void {
  pendingAnswersStore.delete(sessionId);
  questionCountStore.delete(sessionId);
}

export function getQuestionCount(sessionId: string): number {
  return questionCountStore.get(sessionId) || 0;
}

export function setQuestionCount(sessionId: string, count: number): void {
  questionCountStore.set(sessionId, count);
}
