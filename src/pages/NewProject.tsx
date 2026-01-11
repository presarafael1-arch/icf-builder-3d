import { MainLayout } from '@/components/layout/MainLayout';
import { NewProjectForm } from '@/components/project/NewProjectForm';

export default function NewProject() {
  return (
    <MainLayout>
      <div className="space-y-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Novo Projeto</h1>
          <p className="text-muted-foreground mt-1">
            Configure os parâmetros do seu projeto ICF
          </p>
        </div>
        
        <NewProjectForm />
      </div>
    </MainLayout>
  );
}
